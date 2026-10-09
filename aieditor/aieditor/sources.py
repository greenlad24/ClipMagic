"""Where a job's source.mp4 comes from — request.json "source".

  {"kind": "descript", "url": ...}                      download it (descript.download) — unchanged
  {"kind": "job", "job": <id>, "file": "final-01.mp4"}  a finished Lab edit of workflow 1 (cut)
  {"kind": "upload", "upload": <id>, "name": <file>}    a file uploaded from Jake's computer
                                                        (the Lab streams it to jobs/_uploads/<id>/data)
  {"kind": "job_source", "job": <id>, "name": <file>,   the uploaded narration of an EARLIER job whose
   "upload": <id>}                                      _uploads folder is gone (uploads made before the
                                                        library existed): that job's source.mp4

The two local kinds are MATERIALISED into the job's own folder as source.mp4 BEFORE the job
runs (on this box, or before the folder is sent to a factory server — that server can see no
other job folder and no upload). jobs/ is one filesystem (the 500 GB volume), so this is a
hard link: zero copy, zero extra bytes. A copy is the fallback (another filesystem, a link
refused). The source job's files are never moved or modified — and a hard link stays safe
when the source job re-renders its final later: every render writes `<name>.part.mp4` and
os.replace()s it, i.e. a NEW inode, never truncating the shared one.

NARRATION LIBRARY (Jake 2026-10-09: "so I can reuse uploaded narration videos"): an upload is
KEPT after use — any number of jobs hard-link the same _uploads/<id>/data, and only the Lab's
"Remove from library" deletes the folder (jobs keep their own link). source.json records kind,
filename and from_upload / from_job.

⚠️ SOURCE GATE — AUTOMATIC, no human step (Jake 2026-10-09: "it also did cuts inside the
narration that I didn't ask for", then "when a job is being submitted for a new video - I
don't want a review step from my side - everything should be made automatically"). A cut
job writes preview-NN.mp4 the moment its AUTOMATIC cut exists. The factory edit he watched
started from exactly that (factory-e2e-test/preview-01.mp4: 53 joins, 45 removals, no
final). So a cut is a creative source only when one of these holds (review_status):
  final       final-NN.mp4 itself, or a preview whose final-NN.mp4 exists
  reviewed    review.json edited:true (Jake changed it) or approved:true (approved as is)
  verified    wordiff.json of a factory-policy cut with 0 unapproved removals (the word check)
  unreviewed  anything else — ALWAYS refused. There is no override tick any more: a cut that
              fails the word check is re-cut automatically by the chain (aieditor/chain.py),
              never handed to Jake.
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
LOCAL_KINDS = ("job", "upload", "job_source")
# kinds of an earlier job's source.json that make its source.mp4 an uploaded narration
NARRATION_KINDS = ("upload", "job_source")


class SourceError(RuntimeError):
    pass


class UnreviewedSource(SourceError):
    """The Lab edit is an automatic cut nobody reviewed (see REVIEW GATE)."""
    def __init__(self, msg, status):
        super().__init__(msg)
        self.status = status


ACCEPTED = ("final", "reviewed", "verified")


def review_status(jobs_root, jid, fname):
    """{"status": final|reviewed|verified|unreviewed, "removed_words": n|None,
    "removals": n|None} of a cut job's video file (see REVIEW GATE). removed_words counts
    the spoken words removed at the joins of that video (edl.json)."""
    jdir = Path(jobs_root) / jid
    m = re.match(r"^(final|preview)-(\d{2})\.mp4$", fname or "")
    k = int(m.group(2)) if m else 1
    edl = _jload(jdir / "edl.json", {}) or {}
    vids = edl.get("videos") or []
    v = vids[k - 1] if 0 < k <= len(vids) else {}
    joins = v.get("joins") or []
    removed = sum(len(str(j.get("removed") or "").split()) for j in joins) if v else None
    removals = sum(1 for j in joins if str(j.get("removed") or "").strip()) if v else None
    out = {"removed_words": removed, "removals": removals}
    if fname.startswith("final-") or (jdir / f"final-{k:02d}.mp4").is_file():
        return {**out, "status": "final"}
    rv = _jload(jdir / "review.json", {}) or {}
    if rv.get("edited") is True or rv.get("approved") is True:
        return {**out, "status": "reviewed"}
    wd = _jload(jdir / "wordiff.json", {}) or {}
    if wd.get("policy") == "factory" and wd.get("unapproved") == 0 and "approved_by" in wd:
        return {**out, "status": "verified"}
    return {**out, "status": "unreviewed"}


def refusal(jid, fname, rs):
    """The clear message for a refused source (no override exists — see SOURCE GATE)."""
    n = rs.get("removed_words")
    return (f"the Lab edit {jid} ({fname}) is an unreviewed automatic cut"
            + (f" ({n} spoken word(s) removed)" if n else "")
            + " that did not pass the word check — only a final render, a reviewed cut or a factory cut "
              "with every word kept can start a creative edit (a Full edit re-cuts automatically)")


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
        rs = review_status(jobs_root, jid, fname)
        if rs["status"] not in ACCEPTED:
            raise UnreviewedSource(refusal(jid, fname, rs), rs["status"])
        return path, {"kind": "job", "from_job": jid, "from_file": fname, "title": title,
                      "quality": "final" if fname.startswith("final-") else "preview",
                      "review": rs["status"], "removed_words": rs.get("removed_words")}
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
        return path, _upload_facts(uid, name)
    if kind == "job_source":
        jid = str(src.get("job") or "")
        if not JOB_RE.match(jid):
            raise SourceError("the earlier job to reuse the narration of is not a valid job name")
        if jid == self_id:
            raise SourceError("a job cannot use its own video as its source")
        jdir = jobs_root / jid
        path = jdir / "source.mp4"
        if _jload(jdir / "request.json") is None:
            raise SourceError(f"the job {jid} no longer exists")
        if path.is_symlink() or not path.is_file():
            raise SourceError(f"the job {jid} has no source.mp4 any more")
        sj = _jload(jdir / "source.json", {}) or {}
        if sj.get("kind") not in NARRATION_KINDS:
            raise SourceError(f"the source of {jid} is not an uploaded narration")
        name = str(src.get("name") or sj.get("filename") or "upload")[:200]
        return path, _job_source_facts(jid, name, src.get("upload") or sj.get("from_upload") or sj.get("upload"))
    raise SourceError(f"unknown source kind {kind!r}")


def _upload_facts(uid, name):
    return {"kind": "upload", "upload": uid, "from_upload": uid, "filename": name, "title": Path(name).stem}


def _job_source_facts(jid, name, uid=None):
    uid = str(uid) if uid and UPLOAD_RE.match(str(uid)) else None
    return {"kind": "job_source", "from_job": jid, "filename": name, "title": Path(name).stem,
            **({"upload": uid, "from_upload": uid} if uid else {})}


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


def materialise(job_dir, req, jobs_root):
    """Put a local source's bytes at <job>/source.mp4 (no-op when already there, or for a
    Descript source). Returns "link" / "copy" / None (nothing done). Safe to call twice."""
    job_dir = Path(job_dir)
    src = (req or {}).get("source") or {}
    if kind_of(req) == "descript":
        return None
    dst = job_dir / "source.mp4"
    if dst.exists():
        return None
    path, _facts = resolve(src, jobs_root, self_id=job_dir.name)
    # the library entry (an upload folder / the earlier job) is never removed: the link is ours
    return place(path, dst)


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
        rs = review_status(jobs_root, jid, fname) if JOB_RE.match(jid) else {}
        return {"kind": "job", "from_job": jid, "from_file": fname,
                "title": src.get("title") or title or jid,
                "quality": "final" if fname.startswith("final-") else "preview",
                **({"review": rs["status"], "removed_words": rs.get("removed_words")}
                   if (Path(jobs_root) / jid / "request.json").exists() and rs else {})}
    name = str(src.get("name") or "upload")[:200]
    if src.get("kind") == "job_source":
        return _job_source_facts(str(src.get("job") or ""), name, src.get("upload"))
    return _upload_facts(src.get("upload"), name)


def note_for(facts, info):
    dims = f"{info['width']}x{info['height']}, {info['duration'] / 60:.1f} min"
    if facts.get("kind") == "job":
        extra = ""
        if facts.get("review") == "unreviewed":
            n = facts.get("removed_words")
            extra = " · UNREVIEWED automatic cut" + (f" ({n} words removed)" if n else "")
        return f"Lab edit: {facts.get('title')} · {facts.get('from_file')} · {dims}{extra}"
    if facts.get("kind") == "upload":
        return f"Uploaded: {facts.get('filename')} · {dims}"
    if facts.get("kind") == "job_source":
        return f"Uploaded (reused from {facts.get('from_job')}): {facts.get('filename')} · {dims}"
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
