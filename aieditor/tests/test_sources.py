"""Local sources of a creative edit (aieditor/sources.py): a finished Lab edit or an upload.

  materialise   hard link into <job>/source.mp4 (same inode, no copy), copy fallback when
                the link is refused, never touches the source job's file, removes the upload
                folder once the bytes live in the job, idempotent
  resolve       strict names (no traversal, no symlinks), the source job / file / upload must
                exist, an unfinished upload is refused, a job cannot use itself
  prepare       = the worker's "download" stage: probe → source.json (+ kind/from_job/filename)
                and the stage note; an unreadable file fails with a clear message
  worker        run_job's download stage takes the local path (no Descript call)

Run: python3 tests/test_sources.py
"""
import importlib.machinery
import importlib.util
import json
import os
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
        check(not udir.exists(), "the upload folder is removed once the job holds the bytes")
        check((d4 / "source.mp4").read_bytes() == b"MP4!upload", "bytes intact after the folder is gone")
        sj = json.loads((d4 / "source.json").read_text())
        check(sj["kind"] == "upload" and sj["filename"] == "my video.mov" and sj["upload"] == uid, f"facts {sj}")
        check(note == "Uploaded: my video.mov · 3840x2160, 16.1 min", f"note {note!r}")
        # rerun after the upload folder is gone: source.mp4 is there → still fine
        (d4 / "source.json").unlink()
        check(sources.prepare(d4, req4, jobs, fake_probe).startswith("Uploaded: my video.mov"), "re-probe works")

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

    print(f"test_sources: {N} checks passed")


if __name__ == "__main__":
    main()
