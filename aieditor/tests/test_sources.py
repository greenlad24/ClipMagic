"""Local sources of a creative edit (aieditor/sources.py): a finished Lab edit or an upload.

  materialise   hard link into <job>/source.mp4 (same inode, no copy), copy fallback when
                the link is refused, never touches the source job's file, KEEPS the upload
                (the narration library: one upload hard-linked into 2 jobs), idempotent
  job_source    an earlier job's uploaded narration (its source.mp4) when its _uploads folder is
                gone: hard link, strict names, only an uploaded narration, never itself
  resolve       strict names (no traversal, no symlinks), the source job / file / upload must
                exist, an unfinished upload is refused, a job cannot use itself
  prepare       = the worker's "download" stage: probe → source.json (+ kind/from_job/filename)
                and the stage note; an unreadable file fails with a clear message
  worker        run_job's download stage takes the local path (no Descript call)
  review gate   a cut job's preview is a source only when the cut was reviewed (review.json
                edited/approved), has a final, or is a factory cut with 0 unapproved removals;
                an unreviewed automatic cut is ALWAYS refused — there is no override tick
                (Jake 2026-10-09: "I don't want a review step from my side"; a stale
                allow_unreviewed in an old request is ignored) — checked on a scratch copy of
                the real factory-e2e-test ("it also did cuts inside the narration that I didn't ask for")

Run: python3 tests/test_sources.py
"""
import importlib.machinery
import importlib.util
import json
import os
import shutil
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
from aieditor import events, sources  # noqa: E402

N = 0


def check(cond, msg):
    global N
    N += 1
    if not cond:
        raise AssertionError(msg)


def raises(fn, needle):
    try:
        fn()
    except sources.SourceError as exc:
        check(needle in str(exc), f"expected {needle!r} in {exc!r}")
        return
    raise AssertionError(f"expected SourceError({needle!r})")


INFO = {"width": 3840, "height": 2160, "fps": 29.97, "fps_num": 30000, "fps_den": 1001,
        "duration": 966.0, "has_audio": True}


def fake_probe(path):
    if Path(path).read_bytes()[:4] != b"MP4!":
        raise RuntimeError("Invalid data found when processing input")
    return dict(INFO)


def make_lab_edit(jobs, jid="linearity-10050728-8866", files=("final-01.mp4", "preview-01.mp4")):
    d = jobs / jid
    d.mkdir(parents=True)
    (d / "request.json").write_text(json.dumps({"id": jid, "title": "Linearity", "format": "long"}))
    for f in files:
        (d / f).write_bytes(b"MP4!" + f.encode())
    return d


def make_upload(jobs, uid="u" + "ab" * 12, complete=True, body=b"MP4!upload"):
    u = jobs / "_uploads" / uid
    u.mkdir(parents=True)
    (u / "data").write_bytes(body)
    (u / "upload.json").write_text(json.dumps({"id": uid, "name": "my video.mov", "size": len(body),
                                               "received": len(body), "complete": complete}))
    return uid, u


def new_job(jobs, jid, source):
    d = jobs / jid
    d.mkdir(parents=True)
    req = {"id": jid, "format": "long", "sponsored": False, "workflow": "creative", "source": source}
    (d / "request.json").write_text(json.dumps(req))
    return d, req


def load_worker():
    loader = importlib.machinery.SourceFileLoader("aieditor_worker", str(ROOT / "bin" / "aieditor-worker"))
    spec = importlib.util.spec_from_loader("aieditor_worker", loader)
    mod = importlib.util.module_from_spec(spec)
    loader.exec_module(mod)
    return mod


def main():
    with tempfile.TemporaryDirectory() as tmp:
        jobs = Path(tmp) / "jobs"
        jobs.mkdir()
        src = make_lab_edit(jobs)
        before = (src / "final-01.mp4").stat()

        # ── kind_of ──
        check(sources.kind_of({"source": {"kind": "descript", "url": "x"}}) == "descript", "descript")
        check(sources.kind_of({"source": {"url": "x"}}) == "descript", "missing kind = descript (old jobs)")
        check(sources.kind_of({}) == "descript", "no source = descript")
        check(sources.kind_of({"source": {"kind": "job"}}) == "job", "job")
        check(sources.kind_of({"source": {"kind": "upload"}}) == "upload", "upload")

        # ── a Lab edit: hard link ──
        d, req = new_job(jobs, "creative-a-1", {"kind": "job", "job": src.name, "file": "final-01.mp4"})
        check(sources.materialise(d, req, jobs) == "link", "same filesystem → hard link")
        check((d / "source.mp4").stat().st_ino == before.st_ino, "source.mp4 is the SAME inode (no copy)")
        check((src / "final-01.mp4").exists() and (src / "final-01.mp4").read_bytes() == b"MP4!final-01.mp4",
              "the source job's file is untouched")
        check(not list(d.glob("*.placing")), "no temp file left behind")
        check(sources.materialise(d, req, jobs) is None, "second call: already there, nothing done")
        note = sources.prepare(d, req, jobs, fake_probe)
        sj = json.loads((d / "source.json").read_text())
        check(sj["kind"] == "job" and sj["from_job"] == src.name and sj["from_file"] == "final-01.mp4", f"facts {sj}")
        check(sj["title"] == "Linearity" and sj["quality"] == "final", f"title/quality {sj}")
        check(sj["width"] == 3840 and sj["fps_num"] == 30000 and sj["duration"] == 966.0, "probe fields kept")
        check(note == "Lab edit: Linearity · final-01.mp4 · 3840x2160, 16.1 min", f"note {note!r}")

        # a preview of a Lab edit
        d2, req2 = new_job(jobs, "creative-a-2", {"kind": "job", "job": src.name, "file": "preview-01.mp4"})
        sources.prepare(d2, req2, jobs, fake_probe)
        check(json.loads((d2 / "source.json").read_text())["quality"] == "preview", "preview quality recorded")

        # ── copy fallback when the link is refused (another filesystem) ──
        real_link = os.link

        def no_link(a, b):
            raise OSError(18, "Invalid cross-device link")
        os.link = no_link
        try:
            d3, req3 = new_job(jobs, "creative-a-3", {"kind": "job", "job": src.name, "file": "final-01.mp4"})
            check(sources.materialise(d3, req3, jobs) == "copy", "link refused → copy")
        finally:
            os.link = real_link
        check((d3 / "source.mp4").read_bytes() == b"MP4!final-01.mp4", "the copy has the bytes")
        check((d3 / "source.mp4").stat().st_ino != before.st_ino, "a copy is a separate file")
        check((src / "final-01.mp4").stat().st_nlink == before.st_nlink + 1, "only the hard-linked job shares the inode")

        # ── validation ──
        def mat(source, jid="creative-bad"):
            dd = jobs / jid
            if dd.exists():
                for f in dd.iterdir():
                    f.unlink()
                dd.rmdir()
            dd, rq = new_job(jobs, jid, source)
            return sources.materialise(dd, rq, jobs)
        raises(lambda: mat({"kind": "job", "job": "../" + src.name, "file": "final-01.mp4"}), "not a valid")
        raises(lambda: mat({"kind": "job", "job": src.name, "file": "../request.json"}), "not a valid")
        raises(lambda: mat({"kind": "job", "job": src.name, "file": "source.mp4"}), "not a valid")
        raises(lambda: mat({"kind": "job", "job": src.name, "file": "final-1.mp4"}), "not a valid")
        raises(lambda: mat({"kind": "job", "job": "_uploads", "file": "final-01.mp4"}), "not a valid")
        raises(lambda: mat({"kind": "job", "job": "no-such-job", "file": "final-01.mp4"}), "no longer exists")
        raises(lambda: mat({"kind": "job", "job": src.name, "file": "final-02.mp4"}), "has no final-02.mp4")
        raises(lambda: mat({"kind": "job", "job": "creative-self", "file": "final-01.mp4"}, jid="creative-self"),
               "its own video")
        (src / "final-03.mp4").symlink_to("/etc/hostname")
        raises(lambda: mat({"kind": "job", "job": src.name, "file": "final-03.mp4"}), "has no final-03.mp4")
        raises(lambda: mat({"kind": "upload", "upload": "../../etc"}), "not valid")
        raises(lambda: mat({"kind": "upload", "upload": "u" + "0" * 24}), "is gone")
        check(sources.kind_of({"source": {"kind": "weird"}}) == "descript", "unknown kind → treated as descript")

        # ── an upload ──
        uid, udir = make_upload(jobs)
        ino = (udir / "data").stat().st_ino
        d4, req4 = new_job(jobs, "creative-u-1", {"kind": "upload", "upload": uid, "name": "my video.mov"})
        note = sources.prepare(d4, req4, jobs, fake_probe)
        check((d4 / "source.mp4").stat().st_ino == ino, "upload hard-linked in")
        check(udir.exists() and (udir / "data").is_file(), "the upload is KEPT (narration library)")
        sj = json.loads((d4 / "source.json").read_text())
        check(sj["kind"] == "upload" and sj["filename"] == "my video.mov" and sj["upload"] == uid
              and sj["from_upload"] == uid, f"facts {sj}")
        check(note == "Uploaded: my video.mov · 3840x2160, 16.1 min", f"note {note!r}")
        # the SAME upload reused by a second job: both are links of one inode, the library keeps it
        d4b, req4b = new_job(jobs, "creative-u-1b", {"kind": "upload", "upload": uid, "name": "my video.mov"})
        check(sources.materialise(d4b, req4b, jobs) == "link", "second job: hard link too")
        check((d4b / "source.mp4").stat().st_ino == ino, "second job shares the inode")
        check((udir / "data").stat().st_nlink == 3, "library + 2 jobs = 3 links, zero copies")
        check(udir.exists(), "still in the library after the second job")
        check(sources.materialise(d4b, req4b, jobs) is None, "idempotent")
        # removed from the library later: the jobs keep their bytes
        shutil.rmtree(udir)
        check((d4 / "source.mp4").read_bytes() == b"MP4!upload" and (d4b / "source.mp4").read_bytes() == b"MP4!upload",
              "jobs keep their copy after the library entry is removed")
        (d4 / "source.json").unlink()
        check(sources.prepare(d4, req4, jobs, fake_probe).startswith("Uploaded: my video.mov"), "re-probe works")

        # ── job_source: an earlier job's uploaded narration (its _uploads folder is gone) ──
        js = {"kind": "job_source", "job": "creative-u-1", "name": "my video.mov", "upload": uid}
        d9, req9 = new_job(jobs, "creative-js-1", js)
        check(sources.materialise(d9, req9, jobs) == "link", "job_source: hard link")
        check((d9 / "source.mp4").stat().st_ino == ino, "job_source: same inode as the earlier job")
        note = sources.prepare(d9, req9, jobs, fake_probe)
        sj = json.loads((d9 / "source.json").read_text())
        check(sj["kind"] == "job_source" and sj["from_job"] == "creative-u-1" and sj["filename"] == "my video.mov"
              and sj["from_upload"] == uid, f"job_source facts {sj}")
        check(note.startswith("Uploaded (reused from creative-u-1): my video.mov"), f"note {note!r}")
        check(sources.kind_of(req9) == "job_source", "kind_of job_source")
        # a job_source of a job_source works too (the chain of reuse)
        d10, req10 = new_job(jobs, "creative-js-2", {"kind": "job_source", "job": "creative-js-1"})
        check(sources.materialise(d10, req10, jobs) == "link", "job_source of a job_source")
        # validation: strict names, no traversal, no symlink, only an uploaded narration, not itself
        raises(lambda: mat({"kind": "job_source", "job": "../creative-u-1"}), "not a valid job name")
        raises(lambda: mat({"kind": "job_source", "job": "_uploads"}), "not a valid job name")
        raises(lambda: mat({"kind": "job_source", "job": "creative-u-1/source.mp4"}), "not a valid job name")
        raises(lambda: mat({"kind": "job_source", "job": "no-such-job"}), "no longer exists")
        raises(lambda: mat({"kind": "job_source", "job": "creative-bad"}, jid="creative-bad"), "its own video")
        raises(lambda: mat({"kind": "job_source", "job": src.name}), "has no source.mp4")
        (src / "source.mp4").write_bytes(b"MP4!descript")
        (src / "source.json").write_text(json.dumps({"kind": "descript"}))
        raises(lambda: mat({"kind": "job_source", "job": src.name}), "not an uploaded narration")
        (src / "source.mp4").unlink()
        (src / "source.mp4").symlink_to(d4 / "source.mp4")
        raises(lambda: mat({"kind": "job_source", "job": src.name}), "has no source.mp4")
        (src / "source.mp4").unlink()
        (src / "source.json").unlink()

        uid2, udir2 = make_upload(jobs, uid="u" + "cd" * 12, complete=False)
        d5, req5 = new_job(jobs, "creative-u-2", {"kind": "upload", "upload": uid2, "name": "x.mp4"})
        raises(lambda: sources.materialise(d5, req5, jobs), "did not finish")
        check(udir2.exists() and not (d5 / "source.mp4").exists(), "an unfinished upload is left alone")

        uid3, _ = make_upload(jobs, uid="u" + "ef" * 12, body=b"not a video")
        d6, req6 = new_job(jobs, "creative-u-3", {"kind": "upload", "upload": uid3, "name": "notes.mp4"})
        raises(lambda: sources.prepare(d6, req6, jobs, fake_probe), "not a readable video")
        check(not (d6 / "source.json").exists(), "no source.json for an unreadable file")

        # descript: untouched
        d7, req7 = new_job(jobs, "cut-d-1", {"kind": "descript", "url": "https://share.descript.com/view/abcdef"})
        check(sources.materialise(d7, req7, jobs) is None and not (d7 / "source.mp4").exists(), "descript: no-op")

        # ── the worker's download stage takes the local path ──
        W = load_worker()
        W.config.JOBS = jobs
        W.media.probe = fake_probe
        W.descript.download = lambda *a, **k: (_ for _ in ()).throw(AssertionError("Descript must not be called"))

        class Stop(Exception):
            pass

        def stop_audio(*a, **k):
            raise Stop()
        W.media.extract_audio = stop_audio
        d8, _ = new_job(jobs, "creative-w-1", {"kind": "job", "job": src.name, "file": "final-01.mp4"})
        job = W.Job(d8)
        events.set_sink(job.event)
        try:
            W.run_job(job, "run")
        except Stop:
            pass
        finally:
            events.set_sink(None)
        st = job.st["stages"]["download"]
        check(st["state"] == "done", f"download stage done {st}")
        check(st.get("note") == "Lab edit: Linearity · final-01.mp4 · 3840x2160, 16.1 min", f"stage note {st}")
        check((d8 / "source.mp4").stat().st_ino == before.st_ino, "worker hard-linked the Lab edit")

        review_gate(jobs)

    print(f"test_sources: {N} checks passed")


def unreviewed(fn):
    try:
        fn()
    except sources.UnreviewedSource as exc:
        check(exc.status == "unreviewed" and "unreviewed automatic cut" in str(exc), f"refusal {exc!r}")
        return str(exc)
    raise AssertionError("expected UnreviewedSource")


REAL_E2E = Path(os.environ.get("AIEDITOR_E2E_JOB", "/opt/aieditor-work/jobs/factory-e2e-test"))


def review_gate(jobs):
    # ── synthetic cut job: preview only, the automatic cut nobody looked at ──
    cut = jobs / "auto-cut-1009-aaaa"
    cut.mkdir()
    (cut / "request.json").write_text(json.dumps({"id": cut.name, "title": "Auto", "format": "long", "no_edit": True}))
    (cut / "preview-01.mp4").write_bytes(b"MP4!preview")
    (cut / "edl.json").write_text(json.dumps({"videos": [{"joins": [
        {"removed": "So"}, {"removed": "uh,"}, {"removed": ""}, {"removed": "Try for yourself."}]}]}))
    (cut / "review.json").write_text(json.dumps({"edited": False}))
    rs = sources.review_status(jobs, cut.name, "preview-01.mp4")
    check(rs == {"status": "unreviewed", "removed_words": 5, "removals": 3}, f"review_status {rs}")
    src = {"kind": "job", "job": cut.name, "file": "preview-01.mp4"}
    msg = unreviewed(lambda: sources.resolve(src, jobs))
    check("5 spoken word(s) removed" in msg, msg)
    d, req = new_job(jobs, "creative-g-1", src)
    unreviewed(lambda: sources.materialise(d, req, jobs))
    check(not (d / "source.mp4").exists(), "nothing placed from a refused source")
    # no override any more: a stale allow_unreviewed (an old request) is ignored, and nothing is placed
    msg2 = unreviewed(lambda: sources.resolve({**src, "allow_unreviewed": True}, jobs))
    check("did not pass the word check" in msg2 and "tick" not in msg2, f"clear message, no tick: {msg2}")
    d2, req2 = new_job(jobs, "creative-g-2", {**src, "allow_unreviewed": True})
    unreviewed(lambda: sources.prepare(d2, req2, jobs, fake_probe))
    check(not (d2 / "source.mp4").exists(), "nothing placed from an old allow_unreviewed request")
    # a factory cut whose word-diff found an unapproved removal stays unreviewed
    (cut / "wordiff.json").write_text(json.dumps({"policy": "factory", "unapproved": 2, "approved_by": None}))
    unreviewed(lambda: sources.resolve(src, jobs))
    (cut / "wordiff.json").write_text(json.dumps({"policy": "factory", "unapproved": 0, "approved_by": None}))
    check(sources.resolve(src, jobs)[1]["review"] == "verified", "factory cut with 0 unapproved removals: verified")
    (cut / "wordiff.json").unlink()
    (cut / "review.json").write_text(json.dumps({"edited": True}))
    check(sources.resolve(src, jobs)[1]["review"] == "reviewed", "Jake edited the cut: reviewed")
    (cut / "review.json").write_text(json.dumps({"edited": False, "approved": True}))
    check(sources.resolve(src, jobs)[1]["review"] == "reviewed", "Jake approved the cut: reviewed")
    (cut / "review.json").write_text(json.dumps({"edited": False}))
    (cut / "final-01.mp4").write_bytes(b"MP4!final")
    check(sources.resolve(src, jobs)[1]["review"] == "final", "a final exists: the preview is a reviewed cut")
    check(sources.resolve({**src, "file": "final-01.mp4"}, jobs)[1]["review"] == "final", "the final itself")

    # ── a SCRATCH COPY of the real factory-e2e-test (read only; skipped when not on this box) ──
    if not (REAL_E2E / "review.json").exists():
        print("  (factory-e2e-test not on this box: real-job gate check skipped)")
        return
    copy = jobs / "factory-e2e-test"
    copy.mkdir()
    for f in ("request.json", "review.json", "edl.json", "source.json", "plan.json"):
        if (REAL_E2E / f).exists():
            shutil.copyfile(REAL_E2E / f, copy / f)
    (copy / "preview-01.mp4").write_bytes(b"MP4!stand-in for the 1080p preview")
    real = {"kind": "job", "job": "factory-e2e-test", "file": "preview-01.mp4"}
    rs = sources.review_status(jobs, "factory-e2e-test", "preview-01.mp4")
    check(rs["status"] == "unreviewed" and rs["removals"] == 45 and rs["removed_words"] == 49,
          f"factory-e2e-test: an unreviewed automatic cut, 45 removals / 49 words: {rs}")
    unreviewed(lambda: sources.resolve(real, jobs))
    rv = json.loads((copy / "review.json").read_text())
    rv["approved"] = True
    (copy / "review.json").write_text(json.dumps(rv))
    check(sources.resolve(real, jobs)[1]["review"] == "reviewed", "approved:true in the scratch review.json: accepted")


def test_sources():          # pytest entry point
    main()


if __name__ == "__main__":
    main()
