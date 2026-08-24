#!/usr/bin/env python3
"""Tutorial Studio sidecar — an HTTP job API around the `run_reel.py` CLI.

Upstream Tutorial Studio is a one-shot command: you cd into the package and run
`run_reel.py "topic"`, and every stage reads/writes RELATIVE paths under
`.media/tutorial/`. That's fine for one person at a terminal and wrong for a
served tool: two runs in the same directory overwrite each other's script,
slides, frames and reel.

So this wrapper keeps the upstream scripts byte-for-byte and gives each job its
OWN working directory instead:

    DATA_DIR/jobs/<id>/
        .env                     <- written from the container environment
        .media/tutorial/
            fonts elements memes refs   <- symlinks to the read-only asset pack
            (everything else the run produces lands here, per job)
        log.txt                  <- combined stdout/stderr of the pipeline
        job.json                 <- status record, survives a restart

`run_reel.py` is then executed with cwd=<job dir>, so every relative path it
knows resolves inside that job and nothing is shared but the assets.

Two other things this adds on top of the CLI:

* **A queue.** Chromium + ffmpeg + whisper are heavy and the box is shared with
  the Lab's own renders, so exactly one job runs at a time; the rest wait.
* **A shared talking-head slot.** `--reuse-base` is upstream's ~$2-per-run
  saving, but it reuses a file in the CURRENT directory — which, with per-job
  dirs, would never exist. After a fresh run we copy that clip to
  DATA_DIR/base/talkinghead2.mp4, and a reuse-base job copies it back in. The
  saving works across jobs, which is the only place it's useful here.

No public port: compose gives this service no `ports:`, so it is reachable only
over the Docker network, and the Lab proxies it behind the Google Sign-In gate.
API_TOKEN is defense in depth on top of that.
"""

from __future__ import annotations

import base64
import binascii
import json
import os
import shutil
import subprocess
import sys
import threading
import time
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from queue import Queue
from urllib.parse import urlparse, parse_qs

PKG = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.environ.get("DATA_DIR", "/data")
JOBS_DIR = os.path.join(DATA_DIR, "jobs")
AVATARS_DIR = os.path.join(DATA_DIR, "avatars")
BASE_DIR = os.path.join(DATA_DIR, "base")
BASE_CLIP = os.path.join(BASE_DIR, "talkinghead2.mp4")
ASSETS = os.path.join(PKG, "assets", "tutorial")
API_TOKEN = os.environ.get("API_TOKEN", "")
PORT = int(os.environ.get("PORT", "3100"))

# Asset directories symlinked into every job. They are READ-ONLY to the run:
# prep_memes.py writes its normalized clips to memes_ready/, which is a real
# directory inside the job, so the shared pack is never mutated.
ASSET_DIRS = ("fonts", "elements", "memes", "refs")

# Uploaded avatars: the operator makes the start image themselves and uploads it
# here. It is used as the IDENTITY reference for GPT Image 2 — the face is held
# 1:1 while the outfit and the corner of the room change per video. Only real
# image bytes are accepted, checked by magic number rather than by trusting the
# filename or the declared type.
MAX_AVATAR_BYTES = 12 * 1024 * 1024
_IMAGE_MAGIC = (
    (b"\x89PNG\r\n\x1a\n", "png", "image/png"),
    (b"\xff\xd8\xff", "jpg", "image/jpeg"),
)


def _sniff_image(raw: bytes) -> tuple[str, str] | None:
    """(extension, mime) for a supported image, or None. WEBP needs its RIFF
    container checked at two offsets, so it is handled separately."""
    for magic, ext, mime in _IMAGE_MAGIC:
        if raw.startswith(magic):
            return ext, mime
    if raw[:4] == b"RIFF" and raw[8:12] == b"WEBP":
        return "webp", "image/webp"
    return None

# Keys the pipeline needs. Written into each job's .env because most upstream
# scripts read .env directly and do NOT fall back to the environment.
ENV_KEYS = ("APIMART_API_KEY", "ANTHROPIC_API_KEY", "STUDIO_PLAN_MODEL", "SOCIALCRAWL_API_KEY")

# Keys supplied per job by the lab server (which holds them in its write-only
# settings store) rather than present in this container's environment. Kept in
# MEMORY ONLY and keyed by job id: they must never reach the on-disk job record.
# A restart therefore loses them, which is correct — the job it belonged to is
# marked `interrupted` on restart anyway.
_job_keys: dict[str, dict] = {}

_queue: "Queue[str]" = Queue()
_lock = threading.Lock()
_jobs: dict[str, dict] = {}
_running: dict[str, subprocess.Popen] = {}


def _supplied_keys(job_id: str) -> dict:
    with _lock:
        return dict(_job_keys.get(job_id) or {})


def _effective_env(job_id: str) -> dict:
    """The pipeline's keys: this container's environment, with anything the lab
    server sent along with the job taking precedence."""
    env = {k: os.environ[k] for k in ENV_KEYS if os.environ.get(k)}
    env.update({k: v for k, v in _supplied_keys(job_id).items() if k in ENV_KEYS and v})
    return env


# ── avatar store ─────────────────────────────────────────────────────────────

def avatar_dir(avatar_id: str) -> str:
    return os.path.join(AVATARS_DIR, avatar_id)


def _avatar_meta(avatar_id: str) -> dict | None:
    path = os.path.join(avatar_dir(avatar_id), "meta.json")
    try:
        with open(path, encoding="utf-8") as fh:
            return json.load(fh)
    except (OSError, ValueError):
        return None


def avatar_ref_path(avatar_id: str) -> str | None:
    """Absolute path of an avatar's reference image, or None if it is gone."""
    meta = _avatar_meta(avatar_id)
    if not meta:
        return None
    path = os.path.join(avatar_dir(avatar_id), meta.get("file") or "")
    return path if os.path.exists(path) else None


def list_avatars() -> list[dict]:
    out = []
    for name in sorted(os.listdir(AVATARS_DIR)) if os.path.isdir(AVATARS_DIR) else []:
        meta = _avatar_meta(name)
        if meta:
            out.append(meta)
    out.sort(key=lambda m: m.get("created_at") or 0, reverse=True)
    return out


def create_avatar(name: str, environment: str, raw: bytes) -> dict:
    sniffed = _sniff_image(raw)
    if not sniffed:
        raise ValueError("that file is not a PNG, JPEG or WEBP image")
    ext, mime = sniffed
    avatar_id = uuid.uuid4().hex[:12]
    d = avatar_dir(avatar_id)
    os.makedirs(d, exist_ok=True)
    fname = f"ref.{ext}"
    with open(os.path.join(d, fname), "wb") as fh:
        fh.write(raw)
    meta = {
        "id": avatar_id,
        "name": name[:120] or "Untitled avatar",
        "environment": environment[:600],
        "file": fname,
        "mime": mime,
        "bytes": len(raw),
        "created_at": time.time(),
    }
    _write_avatar_meta(meta)
    return meta


def _write_avatar_meta(meta: dict) -> None:
    path = os.path.join(avatar_dir(meta["id"]), "meta.json")
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(meta, fh)
    os.replace(tmp, path)


# ── job records ──────────────────────────────────────────────────────────────

def job_dir(job_id: str) -> str:
    return os.path.join(JOBS_DIR, job_id)


def _write_record(job: dict) -> None:
    path = os.path.join(job_dir(job["id"]), "job.json")
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(job, fh)
    os.replace(tmp, path)


def _update(job_id: str, **fields) -> dict:
    with _lock:
        job = _jobs[job_id]
        job.update(fields)
        _write_record(job)
        return dict(job)


def _load_existing() -> None:
    """Re-read job records after a restart so history survives."""
    os.makedirs(JOBS_DIR, exist_ok=True)
    for name in os.listdir(JOBS_DIR):
        record = os.path.join(JOBS_DIR, name, "job.json")
        if not os.path.exists(record):
            continue
        try:
            with open(record, encoding="utf-8") as fh:
                job = json.load(fh)
        except (OSError, ValueError):
            continue
        # A job that was mid-flight when the container stopped is not running
        # any more; its process is gone. Mark it so, rather than showing a
        # spinner forever.
        if job.get("status") in ("running", "queued"):
            job["status"] = "interrupted"
            job["error"] = "The server restarted while this job was running."
        _jobs[job["id"]] = job


# ── running a job ────────────────────────────────────────────────────────────

def _prepare(job: dict) -> str:
    """Build the per-job working directory and return it."""
    d = job_dir(job["id"])
    media = os.path.join(d, ".media", "tutorial")
    os.makedirs(media, exist_ok=True)
    os.makedirs(os.path.join(media, "assets"), exist_ok=True)
    os.makedirs(os.path.join(media, "shots_in"), exist_ok=True)

    for name in ASSET_DIRS:
        link = os.path.join(media, name)
        target = os.path.join(ASSETS, name)
        if not os.path.exists(link) and os.path.isdir(target):
            os.symlink(target, link)

    # run_reel.py invokes its steps as `scripts/<step>.py` and assemble_reel.py
    # opens `scripts/overlay_engine.html` — all relative to cwd, which for us is
    # this job dir, not the package. One symlink resolves every one of them.
    # Read-only in practice: the steps write into .media/tutorial, never here.
    scripts_link = os.path.join(d, "scripts")
    if not os.path.exists(scripts_link):
        os.symlink(os.path.join(PKG, "scripts"), scripts_link)

    # The upstream scripts read keys from a .env file in cwd, so give each job
    # one built from the container environment. Written 0600 — it holds keys.
    env_path = os.path.join(d, ".env")
    lines = [f"{k}={v}" for k, v in _effective_env(job["id"]).items()]
    fd = os.open(env_path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as fh:
        fh.write("\n".join(lines) + "\n")

    # The avatar's reference image is COPIED in (not symlinked): the run must not
    # be able to touch the library, and a job that outlives its avatar should
    # still render exactly what it started with.
    if job.get("avatar_id"):
        ref = avatar_ref_path(job["avatar_id"])
        if ref:
            dest = os.path.join(d, "avatar_ref" + os.path.splitext(ref)[1])
            if not os.path.exists(dest):
                shutil.copy2(ref, dest)

    # --reuse-base looks for this exact filename in the job's own .media dir.
    if job.get("reuse_base") and os.path.exists(BASE_CLIP):
        shutil.copy2(BASE_CLIP, os.path.join(media, "talkinghead2.mp4"))

    return d


def _run(job_id: str) -> None:
    with _lock:
        job = dict(_jobs[job_id])
    d = _prepare(job)

    cmd = [sys.executable, os.path.join(PKG, "run_reel.py"), job["topic"]]
    if job.get("reuse_base") and os.path.exists(os.path.join(d, ".media/tutorial/talkinghead2.mp4")):
        cmd.append("--reuse-base")
    if job.get("outfit"):
        cmd += ["--outfit", job["outfit"]]
    if job.get("scene"):
        cmd += ["--scene", job["scene"]]
    if job.get("environment"):
        cmd += ["--environment", job["environment"]]
    # The avatar reference and the approved script were staged by _prepare.
    for name in os.listdir(d):
        if name.startswith("avatar_ref."):
            cmd += ["--ref-image", os.path.join(d, name)]
            break
    approved = os.path.join(d, "approved_script.json")
    if os.path.exists(approved):
        cmd += ["--script-json", approved]

    _update(job_id, status="running", started_at=time.time())
    log_path = os.path.join(d, "log.txt")
    env = dict(os.environ)
    # One upstream script (make_tutorial_script.py) reads os.environ instead of
    # the .env file, so a key that arrived with the job has to be here as well.
    env.update(_effective_env(job_id))
    env["PYTHONUNBUFFERED"] = "1"
    # Keep the whisper model cache on the data volume so it is downloaded once,
    # not on every container rebuild.
    env.setdefault("HF_HOME", os.path.join(DATA_DIR, "cache", "hf"))
    env.setdefault("XDG_CACHE_HOME", os.path.join(DATA_DIR, "cache"))

    try:
        with open(log_path, "w", encoding="utf-8") as log:
            proc = subprocess.Popen(cmd, cwd=d, stdout=log, stderr=subprocess.STDOUT, env=env)
            with _lock:
                _running[job_id] = proc
            code = proc.wait()
    except Exception as exc:  # noqa: BLE001
        _update(job_id, status="failed", error=str(exc), finished_at=time.time())
        return
    finally:
        with _lock:
            _running.pop(job_id, None)
            # The keys were only needed for this run; drop them so they do not
            # sit in memory for the life of the container.
            _job_keys.pop(job_id, None)

    reel = os.path.join(d, ".media", "tutorial", "reel.mp4")
    if code == 0 and os.path.exists(reel):
        # Keep this run's talking-head as the reusable base for later jobs.
        head = os.path.join(d, ".media", "tutorial", "talkinghead2.mp4")
        if os.path.exists(head):
            os.makedirs(BASE_DIR, exist_ok=True)
            try:
                shutil.copy2(head, BASE_CLIP)
            except OSError:
                pass
        _update(job_id, status="done", finished_at=time.time(),
                size_bytes=os.path.getsize(reel))
        return

    if job_id in _cancelled:
        _cancelled.discard(job_id)
        _update(job_id, status="cancelled", finished_at=time.time())
        return
    _update(job_id, status="failed", finished_at=time.time(),
            error=_tail(log_path) or f"pipeline exited with code {code}")


_cancelled: set[str] = set()


def _tail(path: str, n: int = 1200) -> str:
    try:
        with open(path, encoding="utf-8", errors="replace") as fh:
            return fh.read()[-n:].strip()
    except OSError:
        return ""


def _worker() -> None:
    while True:
        job_id = _queue.get()
        try:
            _run(job_id)
        except Exception as exc:  # noqa: BLE001 — a crash must not kill the queue
            _update(job_id, status="failed", error=str(exc), finished_at=time.time())
        finally:
            _queue.task_done()


# ── HTTP ─────────────────────────────────────────────────────────────────────

class Handler(BaseHTTPRequestHandler):
    server_version = "TutorialStudio/1.0"

    def log_message(self, fmt, *args):  # quieter, one line per request
        sys.stderr.write("%s - %s\n" % (self.address_string(), fmt % args))

    # -- helpers --
    def _json(self, code: int, payload: dict) -> None:
        body = json.dumps(payload).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _authed(self) -> bool:
        if not API_TOKEN:
            return True
        return self.headers.get("Authorization", "") == f"Bearer {API_TOKEN}"

    def _body(self) -> dict:
        n = int(self.headers.get("Content-Length") or 0)
        if not n:
            return {}
        try:
            return json.loads(self.rfile.read(n).decode() or "{}")
        except ValueError:
            return {}

    # -- routes --
    def do_GET(self):  # noqa: N802
        u = urlparse(self.path)
        parts = [p for p in u.path.split("/") if p]
        if parts == ["api", "health"]:
            self._json(200, {
                "ok": True,
                "has_apimart": bool(os.environ.get("APIMART_API_KEY")),
                "has_anthropic": bool(os.environ.get("ANTHROPIC_API_KEY")),
                "has_base_clip": os.path.exists(BASE_CLIP),
                "queued": _queue.qsize(),
            })
            return
        if not self._authed():
            self._json(401, {"error": "unauthorized"})
            return
        if parts == ["api", "avatars"]:
            self._json(200, {"avatars": list_avatars()})
            return
        if len(parts) == 4 and parts[:2] == ["api", "avatars"] and parts[3] == "image":
            meta = _avatar_meta(parts[2])
            path = avatar_ref_path(parts[2]) if meta else None
            if not path:
                self._json(404, {"error": "no such avatar"})
                return
            raw = open(path, "rb").read()
            self.send_response(200)
            self.send_header("Content-Type", meta.get("mime") or "application/octet-stream")
            self.send_header("Content-Length", str(len(raw)))
            self.end_headers()
            self.wfile.write(raw)
            return
        if parts == ["api", "jobs"]:
            with _lock:
                jobs = sorted(_jobs.values(), key=lambda j: j.get("created_at", 0), reverse=True)
            self._json(200, {"jobs": [_public(j) for j in jobs]})
            return
        if len(parts) == 3 and parts[:2] == ["api", "jobs"]:
            job = _jobs.get(parts[2])
            if not job:
                self._json(404, {"error": "no such job"})
                return
            self._json(200, {"job": _public(job)})
            return
        if len(parts) == 4 and parts[:2] == ["api", "jobs"] and parts[3] == "log":
            job = _jobs.get(parts[2])
            if not job:
                self._json(404, {"error": "no such job"})
                return
            offset = int((parse_qs(u.query).get("offset") or ["0"])[0])
            path = os.path.join(job_dir(parts[2]), "log.txt")
            text, size = "", 0
            if os.path.exists(path):
                size = os.path.getsize(path)
                with open(path, encoding="utf-8", errors="replace") as fh:
                    fh.seek(min(offset, size))
                    text = fh.read()
            self._json(200, {"text": text, "offset": size})
            return
        if len(parts) == 4 and parts[:2] == ["api", "jobs"] and parts[3] == "reel.mp4":
            self._send_reel(parts[2])
            return
        self._json(404, {"error": "not found"})

    def do_POST(self):  # noqa: N802
        if not self._authed():
            self._json(401, {"error": "unauthorized"})
            return
        u = urlparse(self.path)
        parts = [p for p in u.path.split("/") if p]
        if parts == ["api", "avatars"]:
            body = self._body()
            b64 = body.get("image_b64") or ""
            try:
                raw = base64.b64decode(b64, validate=True)
            except (ValueError, binascii.Error):
                self._json(400, {"error": "image_b64 is not valid base64"})
                return
            if not raw:
                self._json(400, {"error": "an image is required"})
                return
            if len(raw) > MAX_AVATAR_BYTES:
                self._json(400, {"error": f"image is larger than {MAX_AVATAR_BYTES // (1024*1024)}MB"})
                return
            try:
                meta = create_avatar((body.get("name") or "").strip(),
                                     (body.get("environment") or "").strip(), raw)
            except ValueError as exc:
                self._json(400, {"error": str(exc)})
                return
            self._json(200, {"avatar": meta})
            return
        if len(parts) == 3 and parts[:2] == ["api", "avatars"]:
            meta = _avatar_meta(parts[2])
            if not meta:
                self._json(404, {"error": "no such avatar"})
                return
            body = self._body()
            if isinstance(body.get("name"), str) and body["name"].strip():
                meta["name"] = body["name"].strip()[:120]
            if isinstance(body.get("environment"), str):
                meta["environment"] = body["environment"].strip()[:600]
            _write_avatar_meta(meta)
            self._json(200, {"avatar": meta})
            return
        if len(parts) == 4 and parts[:2] == ["api", "avatars"] and parts[3] == "delete":
            if not _avatar_meta(parts[2]):
                self._json(404, {"error": "no such avatar"})
                return
            shutil.rmtree(avatar_dir(parts[2]), ignore_errors=True)
            self._json(200, {"deleted": True})
            return
        if parts == ["api", "jobs"]:
            body = self._body()
            topic = (body.get("topic") or "").strip()
            if not topic:
                self._json(400, {"error": "topic is required"})
                return
            # The lab server holds the pipeline's keys in its write-only settings
            # store and sends them with the job. Anything here beats this
            # container's environment; a key absent from both is what the gate
            # below refuses on.
            supplied = body.get("keys")
            supplied = {
                k: v.strip() for k, v in supplied.items()
                if k in ENV_KEYS and isinstance(v, str) and v.strip()
            } if isinstance(supplied, dict) else {}

            if not (supplied.get("APIMART_API_KEY") or os.environ.get("APIMART_API_KEY")):
                self._json(400, {"error": "No apimart API key — set it in Settings so the "
                                          "script, start frame and talking-head stages can run."})
                return
            # An avatar must exist to be referenced — a job pinned to a deleted
            # one would silently fall back to the packaged creator sheet, which
            # is a different person.
            avatar_id = (body.get("avatar_id") or "").strip()
            if avatar_id and not avatar_ref_path(avatar_id):
                self._json(400, {"error": "no such avatar"})
                return

            # A batch sends the script it already had approved; a one-off job
            # leaves this empty and the pipeline writes its own with Qwen.
            script = body.get("script")
            if script is not None and not (
                isinstance(script, dict) and (script.get("script") or "").strip()
            ):
                self._json(400, {"error": "script must be an object with a non-empty 'script'"})
                return

            job = {
                "id": uuid.uuid4().hex[:12],
                "topic": topic[:300],
                "outfit": (body.get("outfit") or "").strip()[:300],
                "scene": (body.get("scene") or "").strip()[:400],
                "environment": (body.get("environment") or "").strip()[:600],
                "avatar_id": avatar_id,
                "batch_id": (body.get("batch_id") or "").strip()[:64],
                "reuse_base": bool(body.get("reuse_base")) and os.path.exists(BASE_CLIP),
                "status": "queued",
                "created_at": time.time(),
                "error": "",
            }
            os.makedirs(job_dir(job["id"]), exist_ok=True)
            if script is not None:
                with open(os.path.join(job_dir(job["id"]), "approved_script.json"),
                          "w", encoding="utf-8") as fh:
                    json.dump(script, fh, ensure_ascii=False)
            with _lock:
                _jobs[job["id"]] = job
                # Deliberately NOT part of `job`: _write_record persists that to
                # disk, and these are secrets.
                if supplied:
                    _job_keys[job["id"]] = supplied
                _write_record(job)
            _queue.put(job["id"])
            self._json(200, {"job": _public(job)})
            return
        if len(parts) == 4 and parts[:2] == ["api", "jobs"] and parts[3] == "cancel":
            job_id = parts[2]
            if job_id not in _jobs:
                self._json(404, {"error": "no such job"})
                return
            with _lock:
                proc = _running.get(job_id)
            if proc and proc.poll() is None:
                _cancelled.add(job_id)
                proc.terminate()
                self._json(200, {"ok": True})
                return
            self._json(409, {"error": "job is not running"})
            return
        self._json(404, {"error": "not found"})

    def _send_reel(self, job_id: str) -> None:
        """Serve the finished mp4, honouring Range so the player can seek."""
        path = os.path.join(job_dir(job_id), ".media", "tutorial", "reel.mp4")
        if not os.path.exists(path):
            self._json(404, {"error": "no reel for this job"})
            return
        size = os.path.getsize(path)
        rng = self.headers.get("Range", "")
        start, end = 0, size - 1
        partial = False
        if rng.startswith("bytes="):
            spec = rng[6:].split(",")[0]
            a, _, b = spec.partition("-")
            if a.strip():
                start = min(int(a), size - 1)
                if b.strip():
                    end = min(int(b), size - 1)
                partial = True
            elif b.strip():  # suffix range: last N bytes
                start = max(0, size - int(b))
                partial = True
        length = end - start + 1
        self.send_response(206 if partial else 200)
        self.send_header("Content-Type", "video/mp4")
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Content-Length", str(length))
        if partial:
            self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
        self.end_headers()
        with open(path, "rb") as fh:
            fh.seek(start)
            remaining = length
            while remaining > 0:
                chunk = fh.read(min(1 << 16, remaining))
                if not chunk:
                    break
                try:
                    self.wfile.write(chunk)
                except (BrokenPipeError, ConnectionResetError):
                    return
                remaining -= len(chunk)


def _public(job: dict) -> dict:
    """The record as the Lab sees it (no filesystem paths)."""
    out = {k: job.get(k) for k in
           ("id", "topic", "outfit", "scene", "environment", "avatar_id", "batch_id",
            "reuse_base", "status", "error",
            "created_at", "started_at", "finished_at", "size_bytes")}
    out["has_reel"] = os.path.exists(
        os.path.join(job_dir(job["id"]), ".media", "tutorial", "reel.mp4"))
    return out


def main() -> None:
    os.makedirs(JOBS_DIR, exist_ok=True)
    os.makedirs(AVATARS_DIR, exist_ok=True)
    _load_existing()
    threading.Thread(target=_worker, daemon=True).start()
    srv = ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
    print(f"tutorial-studio sidecar on :{PORT}  (jobs -> {JOBS_DIR})", flush=True)
    srv.serve_forever()


if __name__ == "__main__":
    main()
