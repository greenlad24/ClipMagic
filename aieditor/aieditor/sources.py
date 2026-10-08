"""Where a job's source.mp4 comes from — request.json "source".

  {"kind": "descript", "url": ...}                      download it (descript.download) — unchanged
  {"kind": "job", "job": <id>, "file": "final-01.mp4"}  a finished Lab edit of workflow 1 (cut)
  {"kind": "upload", "upload": <id>, "name": <file>}    a file uploaded from Jake's computer
                                                        (the Lab streams it to jobs/_uploads/<id>/data)

The two local kinds are MATERIALISED into the job's own folder as source.mp4 BEFORE the job
runs (on this box, or before the folder is sent to a factory server — that server can see no
other job folder and no upload). jobs/ is one filesystem (the 500 GB volume), so this is a
hard link: zero copy, zero extra bytes. A copy is the fallback (another filesystem, a link
refused). The source job's files are never moved or modified — and a hard link stays safe
when the source job re-renders its final later: every render writes `<name>.part.mp4` and
os.replace()s it, i.e. a NEW inode, never truncating the shared one.

An upload folder is removed as soon as its bytes live in the job (the link keeps them).
"""
import json
import os
import re
import shutil
from pathlib import Path

JOB_RE = re.compile(r"^[a-z0-9][a-z0-9-]{2,63}$")
FILE_RE = re.compile(r"^(final|preview)-\d{2}\.mp4$")
UPLOAD_RE = re.compile(r"^u[0-9a-f]{24}$")
UPLOADS_DIR = "_uploads"
LOCAL_KINDS = ("job", "upload")


class SourceError(RuntimeError):
    pass


def kind_of(req):
    k = ((req or {}).get("source") or {}).get("kind") or "descript"
    return k if k in LOCAL_KINDS else "descript"


def _jload(path, default=None):
    try:
        return json.loads(Path(path).read_text())
    except (OSError, ValueError):
        return default


def resolve(src, jobs_root, self_id=None):
    """The file a local source points at + the facts recorded in source.json. Every name is
    checked against a strict pattern (no path traversal) and the file must be a REGULAR file
    directly inside the expected folder (no symlinks)."""
    jobs_root = Path(jobs_root)
    kind = (src or {}).get("kind")
    if kind == "job":
        jid, fname = str(src.get("job") or ""), str(src.get("file") or "")
        if not JOB_RE.match(jid) or not FILE_RE.match(fname):
            raise SourceError("the Lab edit to use is not a valid job/file name")
        if jid == self_id:
            raise SourceError("a job cannot use its own video as its source")
        jdir = jobs_root / jid
        path = jdir / fname
        req = _jload(jdir / "request.json")
        if req is None:
            raise SourceError(f"the Lab edit {jid} no longer exists")
        if path.is_symlink() or not path.is_file():
            raise SourceError(f"the Lab edit {jid} has no {fname} any more")
        title = req.get("title") or (_jload(jdir / "source.json", {}) or {}).get("title") or jid
        return path, {"kind": "job", "from_job": jid, "from_file": fname, "title": title,
                      "quality": "final" if fname.startswith("final-") else "preview"}
    if kind == "upload":
        uid = str(src.get("upload") or "")
        if not UPLOAD_RE.match(uid):
            raise SourceError("the upload id is not valid")
        udir = jobs_root / UPLOADS_DIR / uid
        path = udir / "data"
        meta = _jload(udir / "upload.json", {}) or {}
        if path.is_symlink() or not path.is_file():
            raise SourceError("the uploaded file is gone (uploads are kept 2 days) — upload it again")
        if not meta.get("complete"):
            raise SourceError("the upload did not finish — upload the file again")
        name = str(src.get("name") or meta.get("name") or "upload")[:200]
        return path, {"kind": "upload", "upload": uid, "filename": name, "title": Path(name).stem}
    raise SourceError(f"unknown source kind {kind!r}")


def place(src_path, dst):
    """src → dst via a hard link (same filesystem), else a copy. Atomic: written beside dst,
    then renamed, so a half-placed source.mp4 never exists. Returns "link" or "copy"."""
    dst = Path(dst)
    tmp = dst.with_name(dst.name + ".placing")
    tmp.unlink(missing_ok=True)
    try:
        os.link(src_path, tmp)
        how = "link"
    except OSError:
        shutil.copyfile(src_path, tmp)
        how = "copy"
    os.replace(tmp, dst)
    return how


def _drop_upload(src, jobs_root):
    uid = str((src or {}).get("upload") or "")
    if UPLOAD_RE.match(uid):
        shutil.rmtree(Path(jobs_root) / UPLOADS_DIR / uid, ignore_errors=True)


def materialise(job_dir, req, jobs_root):
    """Put a local source's bytes at <job>/source.mp4 (no-op when already there, or for a
    Descript source). Returns "link" / "copy" / None (nothing done). Safe to call twice."""
    job_dir = Path(job_dir)
    src = (req or {}).get("source") or {}
    if kind_of(req) == "descript":
        return None
    dst = job_dir / "source.mp4"
    if dst.exists():
        if src.get("kind") == "upload":
            _drop_upload(src, jobs_root)
        return None
    path, _facts = resolve(src, jobs_root, self_id=job_dir.name)
    how = place(path, dst)
    if src.get("kind") == "upload":
        _drop_upload(src, jobs_root)                  # the job's link keeps the bytes
    return how


def facts_for(job_dir, req, jobs_root):
    """The source.json facts of a local source — read from the request (and, while it still
    exists, the source job), so it also works after the upload folder is gone and on a
    factory server that has neither."""
    src = (req or {}).get("source") or {}
    if src.get("kind") == "job":
        jid, fname = str(src.get("job") or ""), str(src.get("file") or "")
        title = None
        if JOB_RE.match(jid):
            r = _jload(Path(jobs_root) / jid / "request.json") or {}
            title = r.get("title") or (_jload(Path(jobs_root) / jid / "source.json", {}) or {}).get("title")
        return {"kind": "job", "from_job": jid, "from_file": fname,
                "title": src.get("title") or title or jid,
                "quality": "final" if fname.startswith("final-") else "preview"}
    name = str(src.get("name") or "upload")[:200]
    return {"kind": "upload", "upload": src.get("upload"), "filename": name, "title": Path(name).stem}


def note_for(facts, info):
    dims = f"{info['width']}x{info['height']}, {info['duration'] / 60:.1f} min"
    if facts.get("kind") == "job":
        return f"Lab edit: {facts.get('title')} · {facts.get('from_file')} · {dims}"
    if facts.get("kind") == "upload":
        return f"Uploaded: {facts.get('filename')} · {dims}"
    return dims


def prepare(job_dir, req, jobs_root, probe, progress=lambda msg, frac=None: None):
    """The "download" stage for a local source: materialise (when not done yet), probe, write
    source.json. Returns the stage note."""
    job_dir = Path(job_dir)
    progress("Using the Lab edit…" if kind_of(req) == "job" else "Using the uploaded file…", 0.1)
    if not (job_dir / "source.mp4").exists():
        materialise(job_dir, req, jobs_root)
    if not (job_dir / "source.mp4").exists():
        raise SourceError("the source video is not in the job folder")
    progress("Reading the video…", 0.6)
    try:
        info = probe(job_dir / "source.mp4")
    except Exception as exc:                            # noqa: BLE001
        raise SourceError(f"the source file is not a readable video ({str(exc)[:160]})") from exc
    facts = facts_for(job_dir, req, jobs_root)
    tmp = job_dir / "source.json.tmp"
    tmp.write_text(json.dumps({**facts, **info}, indent=1))
    os.replace(tmp, job_dir / "source.json")
    return note_for(facts, info)
