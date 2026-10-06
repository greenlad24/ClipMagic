#!/usr/bin/env python3
"""storage-agent — the whole-server half of the Lab's Storage page (systemd: storage-agent.service).

The Lab runs in a container and can only see its own data volume and the few host
directories bind-mounted into it. Jake asked for "a comprehensive storage management
tool with all types of files on the server, and when I press delete it should REALLY
be deleted" — so this service runs as root on the HOST and does the two things the
container cannot: see the whole root filesystem, and delete from it.

TRANSPORT: HTTP/1.1 over a unix socket at  /var/lib/storage-agent/sock/agent.sock,
bind-mounted into the Lab as  /storage-agent/agent.sock  (docker-compose.yml). The
Lab server (lab/server/src/zite/serverStorage.ts) is the only client; the UI never
talks to this directly. Anything that can reach the socket can delete files — the
same container already holds /var/run/docker.sock, which is root-equivalent, so this
adds no new privilege, and every guard below is enforced HERE, not in the UI.

WHAT "REALLY DELETED" MEANS (and why a plain unlink is not it):
  * A file's bytes are freed only when its LAST hard link goes. The Hyperframes jobs
    share one 4.9 GB inode across 19 paths; deleting one path frees nothing. So the
    index records every path of every multi-link inode, a delete removes ALL of them
    (each re-verified by (st_dev, st_ino) just before unlink), and a delete is REFUSED
    when fewer links can be found than st_nlink says exist — a partial delete would
    report success and free nothing.
  * A file held open by a process keeps its bytes until that process closes it. We
    scan /proc/*/fd and /proc/*/maps and report "space returns when <process> closes
    it" rather than claiming the space.
  * We measure statfs before and after, and return the bytes ACTUALLY freed next to
    the bytes we expected.

PROTECTION (all server-side; see Rules): system trees, every mount point, Docker's
storage (only ever freed through the Lab's Docker prune actions), the Lab database,
secrets (.env*, keys, dotfiles in home dirs), source trees (/opt/clipmagic, any git
work tree under /opt /root /home /srv), live Claude Code / systemd scratch in /tmp,
bind-mount sources of running containers, Auto Editor / Hyperframes jobs that are
running or queued, and this agent's own files. A directory is refused when anything
protected lies inside it.

Every delete is appended to /var/lib/storage-agent/deletions.log (JSON lines).
Python 3 stdlib only.
"""
import gzip
import heapq
import http.server
import json
import os
import shutil
import socketserver
import stat
import sys
import threading
import time
import traceback
import uuid
from urllib.parse import parse_qs, urlparse

STATE_DIR = os.environ.get("STORAGE_AGENT_STATE", "/var/lib/storage-agent")
SOCK_DIR = os.path.join(STATE_DIR, "sock")
SOCK_PATH = os.path.join(SOCK_DIR, "agent.sock")
INDEX_PATH = os.path.join(STATE_DIR, "index.json.gz")
LOG_PATH = os.path.join(STATE_DIR, "deletions.log")
AGENT_CODE_DIR = os.path.dirname(os.path.abspath(__file__))

REFRESH_EVERY = 6 * 3600          # periodic full re-index
STALE_AT_START = 3600              # re-index at start-up if the cached index is older
TOP_N = 300                        # largest files kept
TOP_PER_TYPE = 60
TREE_LIMIT = 400                   # entries returned per folder listing
PLAN_TTL = 15 * 60
TYPED_CONFIRM_BYTES = 1 << 30      # > 1 GiB needs confirm == "DELETE"
CONFIRM_WORD = "DELETE"

# ───────────────────────────── file types ─────────────────────────────

EXT_TYPES = {
    "video": "mp4 mov mkv webm avi m4v mpg mpeg ts mts m2ts flv wmv 3gp mxf prores",
    "audio": "wav mp3 m4a aac flac ogg opus wma aiff aif caf",
    "image": "jpg jpeg png gif webp bmp tif tiff heic heif svg psd avif ico raw cr2 nef exr",
    "archive": "zip tar gz tgz bz2 xz zst 7z rar iso img dmg deb rpm whl jar",
    "model": "safetensors ckpt pt pth onnx gguf ggml h5 tflite pb mlmodel npz npy",
    "document": "pdf doc docx xls xlsx ppt pptx odt ods odp txt md csv rtf epub srt vtt ass",
    "database": "db sqlite sqlite3 db-wal db-shm sqlite-wal sqlite-shm wal mdb ldb rdb aof",
    "log": "log journal out err",
    "code": "js mjs cjs ts tsx jsx py pyc json html htm css map sh go rs c h cpp java rb php yml yaml toml xml lock wasm",
    "library": "so a o node dll dylib",
}
EXT_MAP = {}
for _t, _exts in EXT_TYPES.items():
    for _e in _exts.split():
        EXT_MAP[_e] = _t
TYPE_LABELS = {
    "docker": "Docker-managed (images, layers, volumes)",
    "video": "Video", "audio": "Audio", "image": "Images", "archive": "Archives & disk images",
    "model": "AI models & weights", "document": "Documents & text", "database": "Databases",
    "log": "Logs", "code": "Code & config", "library": "Libraries & binaries",
    "dependencies": "Dependencies (node_modules, venvs, caches)", "swap": "Swap",
    "other": "Other",
}
DOCKER_PREFIXES = ("/var/lib/docker/", "/var/lib/containerd/")
DEP_MARKERS = ("/node_modules/", "/site-packages/", "/.cache/", "/__pycache__/", "/.npm/", "/dist-packages/")


def classify(path, name):
    if path.startswith("/var/lib/docker/") or path.startswith("/var/lib/containerd/"):
        return "docker"
    if path == "/swapfile":
        return "swap"
    for m in DEP_MARKERS:
        if m in path:
            return "dependencies"
    dot = name.rfind(".")
    if dot > 0:
        ext = name[dot + 1:].lower()
        t = EXT_MAP.get(ext)
        if t:
            return t
        if ext.isdigit() and ".log" in name:      # rotated logs: syslog.2, app.log.1
            return "log"
    if path.startswith("/var/log/"):
        return "log"
    return "other"


def alloc_of(st):
    """Bytes the file actually occupies on disk (what df counts), not its apparent size."""
    return getattr(st, "st_blocks", 0) * 512


def norm(p):
    if not isinstance(p, str) or not p.startswith("/") or "\x00" in p:
        raise ValueError("Paths must be absolute.")
    return os.path.normpath(p) if p != "/" else "/"


def under(path, prefix):
    """path is prefix or lies inside it (segment-exact)."""
    if prefix == "/":
        return True
    return path == prefix or path.startswith(prefix + "/")


def ancestors(path):
    """'/a/b/c' -> ['/a/b', '/a', '/'] (excludes path itself)."""
    out = []
    while path != "/":
        path = os.path.dirname(path)
        out.append(path)
    return out


# ───────────────────────────── the index ─────────────────────────────

class Index:
    """One full walk of a filesystem: per-directory sizes, type breakdown, largest
    files and every multi-link inode's paths. Hard links count once (dedupe by inode)."""

    def __init__(self):
        self.root = "/"
        self.built_at = 0
        self.duration = 0
        self.dirs = {}         # path -> [alloc, files, shared]
        self.types = {}        # type -> {"bytes", "files", "top": [...]}
        self.largest = []      # [{path, size, apparent, nlink, mtime, ino, type}]
        self.multi = {}        # "ino" -> [alloc, apparent, nlink, [paths]]
        self.mounts = []       # mount points met (other st_dev) inside the walk
        self.repos = []        # directories holding a .git
        self.errors = 0
        self.files = 0

    # -- build --
    @classmethod
    def build(cls, root="/", progress=None):
        t0 = time.time()
        ix = cls()
        ix.root = root
        rst = os.lstat(root)
        rdev = rst.st_dev
        direct = {}            # dir -> [alloc, files]
        multi = {}             # ino -> [alloc, apparent, nlink, paths, mtime, name]
        largest = []           # heap of (alloc, path, ...)
        types = {}
        tops = {}
        seq = 0
        stack = [root]
        direct[root] = [alloc_of(rst), 0]
        nfiles = 0
        while stack:
            d = stack.pop()
            try:
                it = os.scandir(d)
            except OSError:
                ix.errors += 1
                continue
            with it:
                for e in it:
                    p = e.path if d != "/" else "/" + e.name
                    try:
                        st = e.stat(follow_symlinks=False)
                    except OSError:
                        ix.errors += 1
                        continue
                    if st.st_dev != rdev:
                        ix.mounts.append(p)
                        continue
                    m = st.st_mode
                    if stat.S_ISDIR(m):
                        direct[p] = [alloc_of(st), 0]
                        if e.name == ".git":
                            ix.repos.append(d)
                        stack.append(p)
                        continue
                    if not stat.S_ISREG(m):
                        if stat.S_ISLNK(m):
                            direct[d][0] += alloc_of(st)
                        continue
                    nfiles += 1
                    if progress and nfiles % 50000 == 0:
                        progress(nfiles)
                    a = alloc_of(st)
                    if st.st_nlink > 1:
                        k = st.st_ino
                        rec = multi.get(k)
                        if rec is None:
                            multi[k] = [a, st.st_size, st.st_nlink, [p], st.st_mtime, e.name]
                        else:
                            rec[3].append(p)
                            continue     # counted once, at its first path
                    else:
                        dd = direct[d]
                        dd[0] += a
                        dd[1] += 1
                    t = classify(p, e.name)
                    tt = types.get(t)
                    if tt is None:
                        tt = types[t] = [0, 0]
                        tops[t] = []
                    tt[0] += a
                    tt[1] += 1
                    seq += 1
                    item = (a, seq, p, st.st_size, st.st_nlink, st.st_mtime, st.st_ino, t)
                    if len(largest) < TOP_N:
                        heapq.heappush(largest, item)
                    elif a > largest[0][0]:
                        heapq.heapreplace(largest, item)
                    tp = tops[t]
                    if len(tp) < TOP_PER_TYPE:
                        heapq.heappush(tp, item)
                    elif a > tp[0][0]:
                        heapq.heapreplace(tp, item)
        # roll direct sizes up the tree (deepest first)
        dirs = {p: [v[0], v[1], 0] for p, v in direct.items()}
        for p in sorted(dirs, key=lambda x: x.count("/"), reverse=True):
            if p == root:
                continue
            parent = os.path.dirname(p)
            pv = dirs.get(parent)
            if pv is not None:
                v = dirs[p]
                pv[0] += v[0]
                pv[1] += v[1]
        # multi-link inodes: count once in every directory holding any of their links;
        # mark as "shared" in directories that hold only some of them.
        for ino, (a, app, nlink, paths, mtime, name) in multi.items():
            union = set()
            common = None
            for p in paths:
                anc = ancestors(p)
                union.update(anc)
                common = set(anc) if common is None else common & set(anc)
            for anc in union:
                v = dirs.get(anc)
                if v is None:
                    continue
                v[0] += a
                v[1] += 1
                if len(paths) < nlink or anc not in common:
                    v[2] += a
            # Docker's own hard links (220k of them on this box) are never deleted from
            # here, so only inodes with at least one path outside Docker are kept.
            if not all(p.startswith(DOCKER_PREFIXES) for p in paths):
                ix.multi[str(ino)] = [a, app, nlink, paths]
        ix.dirs = dirs
        ix.largest = [cls._item(x, multi) for x in sorted(largest, reverse=True)]
        ix.types = {
            t: {"bytes": v[0], "files": v[1], "top": [cls._item(x, multi) for x in sorted(tops[t], reverse=True)]}
            for t, v in types.items()
        }
        ix.files = nfiles
        ix.built_at = time.time()
        ix.duration = ix.built_at - t0
        return ix

    @staticmethod
    def _item(x, multi):
        a, _seq, p, app, nlink, mtime, ino, t = x
        rec = {"path": p, "size": a, "apparent": app, "nlink": nlink, "mtime": int(mtime * 1000), "ino": ino, "type": t}
        if nlink > 1 and ino in multi:
            rec["links"] = multi[ino][3][:50]
            rec["linksFound"] = len(multi[ino][3])
        return rec

    # -- persistence --
    def to_json(self):
        return {
            "v": 1, "root": self.root, "builtAt": self.built_at, "duration": self.duration,
            "dirs": self.dirs, "types": self.types, "largest": self.largest, "multi": self.multi,
            "mounts": self.mounts, "repos": self.repos, "errors": self.errors, "files": self.files,
        }

    @classmethod
    def from_json(cls, d):
        ix = cls()
        ix.root = d["root"]
        ix.built_at = d["builtAt"]
        ix.duration = d["duration"]
        ix.dirs = d["dirs"]
        ix.types = d["types"]
        ix.largest = d["largest"]
        ix.multi = d["multi"]
        ix.mounts = d.get("mounts", [])
        ix.repos = d.get("repos", [])
        ix.errors = d.get("errors", 0)
        ix.files = d.get("files", 0)
        return ix

    def save(self, path):
        tmp = path + ".tmp"
        with gzip.open(tmp, "wt", compresslevel=3) as f:
            json.dump(self.to_json(), f)
        os.replace(tmp, path)

    @classmethod
    def load(cls, path):
        with gzip.open(path, "rt") as f:
            return cls.from_json(json.load(f))

    # -- queries --
    def links_of(self, ino):
        rec = self.multi.get(str(ino))
        return list(rec[3]) if rec else []

    def hardlink_groups(self, limit=100, min_bytes=1 << 20):
        groups = [
            {"ino": int(k), "size": v[0], "apparent": v[1], "nlink": v[2], "linksFound": len(v[3]), "paths": v[3][:50]}
            for k, v in self.multi.items() if v[0] >= min_bytes
        ]
        groups.sort(key=lambda g: g["size"] * max(1, g["nlink"]), reverse=True)
        return groups[:limit]

    def forget(self, removed_paths, bytes_by_target):
        """Best-effort patch after a delete, until the follow-up re-index lands."""
        dead = list(removed_paths)
        def gone(p):
            return any(under(p, r) for r in dead)
        for t, b in bytes_by_target.items():
            for anc in ancestors(t):
                v = self.dirs.get(anc)
                if v:
                    v[0] = max(0, v[0] - b)
        for p in [p for p in self.dirs if gone(p)]:
            del self.dirs[p]
        self.largest = [x for x in self.largest if not gone(x["path"])]
        for t in self.types.values():
            removed = [x for x in t["top"] if gone(x["path"])]
            for x in removed:
                t["bytes"] = max(0, t["bytes"] - x["size"])
                t["files"] = max(0, t["files"] - 1)
            t["top"] = [x for x in t["top"] if not gone(x["path"])]
        for k in [k for k, v in self.multi.items() if all(gone(p) for p in v[3])]:
            del self.multi[k]


# ───────────────────────────── protection ─────────────────────────────

SYSTEM_TREES = [
    "/bin", "/boot", "/dev", "/etc", "/lib", "/lib32", "/lib64", "/libx32", "/proc", "/sbin",
    "/sys", "/usr", "/snap", "/run", "/lost+found", "/var/lib", "/var/spool", "/var/mail",
    "/var/cache/apt", "/var/cache/debconf",
    "/opt/containerd", "/opt/digitalocean",
]
DOCKER_TREES = ["/var/lib/docker", "/var/lib/containerd"]
SOURCE_TREES = ["/opt/clipmagic"]          # the Lab's repo — code, compose, .env, the worker
# Installed tools and the assets the host workers load on every job. Deleting one breaks a
# service rather than freeing working space, so they are locked; their job/output folders
# (/opt/aieditor-work/jobs, /opt/hyperframes-work, /opt/hfp-lab/runs) stay deletable.
SERVICE_TREES = [
    "/opt/jakedawson-hyperframes", "/opt/hyperframes-pipeline", "/opt/hyperframes-runner",
    "/opt/hyperframes-dist", "/opt/avatar-narrator", "/opt/hfp-lab/control",
    "/opt/aieditor-work/models", "/opt/aieditor-work/templates", "/opt/aieditor-work/sfx",
]
PRIVATE_TREES = ["/root/.claude", "/root/.ssh"]
REPO_ROOTS = ["/opt", "/root", "/home", "/srv", "/var/www"]   # git work trees here are source
HOME_ROOTS = ["/root", "/home"]
DOTFILE_OK = {".cache", ".npm"}            # reclaimable caches inside a home dir
TMP_LIVE_PREFIXES = ("claude-", "systemd-private-", "tmux-", ".X11-unix", ".ICE-unix", "snap-private-tmp")
LAB_DB_SUFFIX = "/_data/db"                # <docker volumes>/clipmagic*-lab-data/_data/db
JOB_ROOTS = ["/opt/aieditor-work/jobs", "/opt/hyperframes-work/jobs"]
JOB_FINISHED = {"done", "failed", "error", "cancelled", "canceled", "interrupted", "complete", "completed"}
SECRET_EXACT = {".git-credentials", ".netrc", ".npmrc", ".pgpass", "id_rsa", "id_ed25519", "id_ecdsa"}


def is_secret_name(name):
    n = name.lower()
    return (n == ".env" or n.startswith(".env.") or n.endswith(".env") or n in SECRET_EXACT
            or n.endswith(".pem") or n.endswith(".key"))


def read_mountpoints():
    out = set()
    try:
        with open("/proc/self/mountinfo") as f:
            for line in f:
                parts = line.split()
                if len(parts) > 4:
                    out.add(parts[4].replace("\\040", " "))
    except OSError:
        pass
    return out


def read_swaps():
    try:
        with open("/proc/swaps") as f:
            return {l.split()[0] for l in f.readlines()[1:] if l.strip()}
    except OSError:
        return set()


def docker_bind_sources():
    """Host paths bind-mounted into RUNNING containers (deleting one breaks that container)."""
    import socket
    out = set()
    try:
        s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        s.settimeout(5)
        s.connect("/var/run/docker.sock")
        s.sendall(b"GET /containers/json HTTP/1.0\r\nHost: docker\r\n\r\n")
        buf = b""
        while True:
            c = s.recv(65536)
            if not c:
                break
            buf += c
        s.close()
        body = buf.split(b"\r\n\r\n", 1)[1]
        for c in json.loads(body):
            for m in c.get("Mounts", []):
                if m.get("Type") == "bind" and m.get("Source"):
                    out.add(os.path.normpath(m["Source"]))
    except Exception:
        pass
    return out


def job_busy(job_dir):
    """A job directory something is using right now (running, or queued to run)."""
    if os.path.exists(os.path.join(job_dir, "queue.json")):
        return "queued"
    for name in ("status.json", "job.json"):
        try:
            with open(os.path.join(job_dir, name)) as f:
                st = json.load(f).get("state")
        except (OSError, ValueError, AttributeError):
            continue
        if st and str(st).lower() not in JOB_FINISHED:
            return str(st)
        if st:
            return None
    return None


class Rules:
    """Every refusal the agent makes. `check(path)` covers one path (and its parents);
    `check_inside(path, name, is_dir)` covers something met while walking a folder."""

    def __init__(self, extra_protected=(), mounts=None, binds=None, job_roots=None, repo_roots=None,
                 home_roots=None, state_dir=STATE_DIR, agent_dir=AGENT_CODE_DIR, root="/"):
        self.root = root
        self.mounts = read_mountpoints() if mounts is None else set(mounts)
        self.binds = docker_bind_sources() if binds is None else set(binds)
        self.swaps = read_swaps()
        self.job_roots = JOB_ROOTS if job_roots is None else list(job_roots)
        self.repo_roots = REPO_ROOTS if repo_roots is None else list(repo_roots)
        self.home_roots = HOME_ROOTS if home_roots is None else list(home_roots)
        self.trees = []        # (prefix, reason)
        for p in SYSTEM_TREES:
            self.trees.append((p, "system files"))
        for p in DOCKER_TREES:
            self.trees.append((p, "Docker-managed storage — free it with the Docker clean-up actions above, never by deleting files"))
        for p in SOURCE_TREES:
            self.trees.append((p, "the Lab's source code and configuration"))
        for p in SERVICE_TREES:
            self.trees.append((p, "an installed tool / assets a server worker loads"))
        for p in PRIVATE_TREES:
            self.trees.append((p, "private credentials / Claude Code state"))
        self.trees.append((state_dir, "the storage agent's own files"))
        self.trees.append((agent_dir, "the storage agent's own files"))
        for p in extra_protected:
            self.trees.append((p, "protected"))

    def refresh_dynamic(self):
        self.mounts = read_mountpoints()
        self.binds = docker_bind_sources()
        self.swaps = read_swaps()

    # A path is refused if it, or any parent, is protected.
    def check(self, path):
        if path in self.swaps:
            return "the active swap file"
        if path == "/" or os.path.dirname(path) == "/":
            return "a top-level path of the filesystem (delete what is inside it instead)"
        if path in self.mounts:
            return "a mount point"
        if path in self.binds:
            return "mounted into a running container (delete what is inside it instead)"
        for prefix, why in self.trees:
            if under(path, prefix):
                return why
        name = os.path.basename(path)
        if is_secret_name(name):
            return "a secrets / environment file"
        if "/_data/db" in path and "lab-data" in path:
            return "the Lab's database"
        # dotfiles/dot-dirs directly in a home directory hold config + credentials
        for h in self.home_roots:
            if under(path, h):
                rel = path[len(h):].lstrip("/").split("/")
                parts = rel if h == "/root" else rel[1:]   # /home/<user>/...
                if parts and parts[0].startswith(".") and parts[0] not in DOTFILE_OK:
                    return "a configuration/credentials folder in a home directory"
        if under(path, "/tmp") or under(path, "/var/tmp"):
            rel = path.split("/")
            if len(rel) > 2 and rel[2].startswith(TMP_LIVE_PREFIXES):
                return "live scratch space of a running service or Claude Code session"
        for jr in self.job_roots:
            if path.startswith(jr + "/"):
                job = jr + "/" + path[len(jr) + 1:].split("/")[0]
                why = job_busy(job)
                if why:
                    return f"a job that is {why} right now ({os.path.basename(job)})"
        # inside a git work tree under a source root
        for anc in [path] + ancestors(path):
            if anc in ("/",):
                break
            if any(under(anc, r) and anc != r for r in self.repo_roots) and os.path.isdir(os.path.join(anc, ".git")):
                return f"source code (git repository {anc})"
        # protected things BELOW this path make the whole folder undeletable
        for prefix, why in self.trees:
            if prefix.startswith(path + "/"):
                return f"contains {prefix} ({why})"
        for m in self.mounts:
            if m.startswith(path + "/"):
                return f"contains the mount point {m}"
        for b in self.binds:
            if b.startswith(path + "/"):
                return f"contains {b}, which is mounted into a running container"
        for jr in self.job_roots:
            if under(jr, path) and os.path.isdir(jr):
                try:
                    for j in os.listdir(jr):
                        why = job_busy(os.path.join(jr, j))
                        if why:
                            return f"contains a job that is {why} right now ({j})"
                except OSError:
                    pass
        return None

    def check_inside(self, path, name, is_dir):
        """Something found while walking a folder we are about to delete."""
        if is_secret_name(name):
            return f"contains a secrets file ({path})"
        if is_dir and name == ".git":
            parent = os.path.dirname(path)
            if any(under(parent, r) for r in self.repo_roots):
                return f"contains a git repository ({parent})"
        return None


# ───────────────────────────── open files ─────────────────────────────

def open_holders(wanted):
    """{(dev, ino): [{"pid", "comm", "how"}]} for the inodes in `wanted` that a process
    has open (fd) or mapped. Its blocks are only freed when that process lets go."""
    out = {}
    if not wanted:
        return out
    for pid in os.listdir("/proc"):
        if not pid.isdigit():
            continue
        comm = "?"
        try:
            with open(f"/proc/{pid}/comm") as f:
                comm = f.read().strip()
        except OSError:
            continue
        fdd = f"/proc/{pid}/fd"
        try:
            fds = os.listdir(fdd)
        except OSError:
            fds = []
        for fd in fds:
            try:
                st = os.stat(f"{fdd}/{fd}")
            except OSError:
                continue
            k = (st.st_dev, st.st_ino)
            if k in wanted:
                out.setdefault(k, []).append({"pid": int(pid), "comm": comm, "how": "open"})
        try:
            with open(f"/proc/{pid}/maps") as f:
                for line in f:
                    parts = line.split(None, 5)
                    if len(parts) < 6 or parts[4] == "0":
                        continue
                    try:
                        ma, mi = parts[3].split(":")
                        k = (os.makedev(int(ma, 16), int(mi, 16)), int(parts[4]))
                    except ValueError:
                        continue
                    if k in wanted and not any(h["pid"] == int(pid) for h in out.get(k, [])):
                        out.setdefault(k, []).append({"pid": int(pid), "comm": comm, "how": "mapped"})
        except OSError:
            pass
    return out


def disk_free(path="/"):
    s = os.statvfs(path)
    return {"total": s.f_blocks * s.f_frsize, "free": s.f_bavail * s.f_frsize,
            "used": (s.f_blocks - s.f_bfree) * s.f_frsize, "bfree": s.f_bfree * s.f_frsize}


# ───────────────────────────── the agent ─────────────────────────────

class Agent:
    def __init__(self, root="/", state_dir=STATE_DIR, rules=None, log_path=None, index_path=None):
        self.root = root
        self.state_dir = state_dir
        self.rules = rules or Rules()
        self.log_path = log_path or os.path.join(state_dir, "deletions.log")
        self.index_path = index_path or os.path.join(state_dir, "index.json.gz")
        self.index = None
        self.lock = threading.Lock()          # one delete at a time
        self.scan_lock = threading.Lock()
        self.scanning = False
        self.scan_progress = 0
        self.scan_started = 0
        self.scan_error = None
        self.scan_thread = None
        self.rescan = False      # a delete landed mid-walk: walk again when this one ends
        self.plans = {}

    # -- indexing --
    def load_cached(self):
        try:
            self.index = Index.load(self.index_path)
        except Exception:
            self.index = None

    def refresh(self, wait=False):
        if self.scanning:
            self.rescan = True
            return False
        def run():
            with self.scan_lock:
                self.scanning = True
                self.scan_started = time.time()
                self.scan_progress = 0
                self.scan_error = None
                try:
                    while True:
                        self.rescan = False
                        ix = Index.build(self.root, progress=lambda n: setattr(self, "scan_progress", n))
                        if not self.rescan:
                            break
                    self.index = ix
                    try:
                        ix.save(self.index_path)
                    except OSError as e:
                        self.scan_error = f"index not cached: {e}"
                except Exception as e:  # keep serving the old index
                    self.scan_error = str(e)
                    traceback.print_exc()
                finally:
                    self.scanning = False
        if wait:
            run()
        else:
            self.scan_thread = threading.Thread(target=run, daemon=True)
            self.scan_thread.start()
        return True

    def status(self):
        ix = self.index
        return {
            "indexing": self.scanning, "progress": self.scan_progress,
            "scanStartedAt": int(self.scan_started * 1000) if self.scanning else None,
            "builtAt": int(ix.built_at * 1000) if ix else None,
            "duration": round(ix.duration, 1) if ix else None,
            "files": ix.files if ix else 0, "error": self.scan_error,
            "disk": disk_free(self.root),
        }

    # -- queries --
    def summary(self):
        ix = self.index
        st = self.status()
        if not ix:
            return {**st, "ready": False}
        types = [
            {"type": t, "label": TYPE_LABELS.get(t, t), "bytes": v["bytes"], "files": v["files"]}
            for t, v in ix.types.items()
        ]
        types.sort(key=lambda x: x["bytes"], reverse=True)
        return {
            **st, "ready": True, "types": types,
            "largest": [self._annotate(x) for x in ix.largest[:150]],
            "hardlinks": [{**g, "protected": self.rules.check(g["paths"][0]) if g["paths"] else None}
                          for g in ix.hardlink_groups(60)],
            "indexed": ix.dirs.get(self.root, [0, 0, 0])[0],
        }

    def by_type(self, t):
        ix = self.index
        if not ix or t not in ix.types:
            return {"type": t, "files": []}
        return {"type": t, "label": TYPE_LABELS.get(t, t), "files": [self._annotate(x) for x in ix.types[t]["top"]]}

    def _annotate(self, x):
        x = dict(x)
        x["protected"] = self.rules.check(x["path"])
        return x

    def tree(self, path):
        path = norm(path)
        ix = self.index
        entries = []
        total_entries = 0
        try:
            it = os.scandir(path)
        except OSError as e:
            return {"path": path, "error": str(e), "entries": []}
        rdev = os.lstat(self.root).st_dev
        with it:
            for e in it:
                total_entries += 1
                p = e.path if path != "/" else "/" + e.name
                try:
                    st = e.stat(follow_symlinks=False)
                except OSError:
                    continue
                rec = {"name": e.name, "path": p, "mtime": int(st.st_mtime * 1000)}
                if stat.S_ISDIR(st.st_mode):
                    rec["kind"] = "dir"
                    if st.st_dev != rdev:
                        rec["mount"] = True
                        rec["size"] = 0
                    else:
                        v = ix.dirs.get(p) if ix else None
                        if v:
                            rec["size"], rec["files"], rec["shared"] = v[0], v[1], v[2]
                        else:
                            rec["size"] = None   # not in the index yet
                elif stat.S_ISREG(st.st_mode):
                    rec["kind"] = "file"
                    rec["size"] = alloc_of(st)
                    rec["apparent"] = st.st_size
                    rec["nlink"] = st.st_nlink
                    rec["type"] = classify(p, e.name)
                elif stat.S_ISLNK(st.st_mode):
                    rec["kind"] = "link"
                    rec["size"] = 0
                    try:
                        rec["target"] = os.readlink(p)
                    except OSError:
                        pass
                else:
                    rec["kind"] = "other"
                    rec["size"] = 0
                entries.append(rec)
        entries.sort(key=lambda r: (r["size"] is None, -(r["size"] or 0)))
        entries = entries[:TREE_LIMIT]
        for r in entries:
            r["protected"] = self.rules.check(r["path"])
        own = ix.dirs.get(path) if ix else None
        return {
            "path": path, "parent": os.path.dirname(path) if path != "/" else None,
            "size": own[0] if own else None, "files": own[1] if own else None,
            "protected": self.rules.check(path) if path != "/" else "the root of the filesystem",
            "entries": entries, "totalEntries": total_entries, "truncated": total_entries > len(entries),
        }

    def log_tail(self, limit=50):
        try:
            with open(self.log_path) as f:
                lines = f.readlines()[-limit:]
        except OSError:
            return []
        out = []
        for l in reversed(lines):
            try:
                out.append(json.loads(l))
            except ValueError:
                pass
        return out

    # -- planning --
    def _verify_links(self, st, target, ix):
        """Every path of the inode `st` — re-verified by (dev, ino) right now."""
        cand = set([target])
        if st.st_nlink > 1 and ix:
            cand.update(ix.links_of(st.st_ino))
        good = []
        for p in cand:
            try:
                s = os.lstat(p)
            except OSError:
                continue
            if s.st_dev == st.st_dev and s.st_ino == st.st_ino:
                good.append(p)
        return sorted(good)

    def analyze(self, raw_path):
        """What deleting this path would really remove, or why it is refused."""
        res = {"path": raw_path, "ok": False}
        try:
            path = norm(raw_path)
        except ValueError as e:
            return {**res, "reason": str(e)}
        res["path"] = path
        try:
            st = os.lstat(path)
        except OSError:
            return {**res, "reason": "no longer exists"}
        # every PARENT must be a real directory, not a symlink detour into a protected tree
        parent = os.path.dirname(path)
        if os.path.realpath(parent) != parent:
            return {**res, "reason": "reached through a symbolic link — browse to the real location instead"}
        why = self.rules.check(path)
        if why:
            return {**res, "reason": f"protected: {why}"}
        rdev = os.lstat(self.root).st_dev
        if st.st_dev != rdev:
            return {**res, "reason": "on a different filesystem"}
        ix = self.index
        inodes = {}          # (dev, ino) -> {"size", "paths": [...], "nlink"}
        dirs = []
        if stat.S_ISDIR(st.st_mode):
            res["kind"] = "dir"
            files = 0
            dir_bytes = 0
            stack = [path]
            while stack:
                d = stack.pop()
                try:
                    it = os.scandir(d)
                except OSError as e:
                    return {**res, "reason": f"cannot read {d}: {e.strerror}"}
                with it:
                    for e in it:
                        try:
                            s = e.stat(follow_symlinks=False)
                        except OSError:
                            continue
                        isdir = stat.S_ISDIR(s.st_mode)
                        bad = self.rules.check_inside(e.path, e.name, isdir)
                        if bad:
                            return {**res, "reason": f"protected: {bad}"}
                        if s.st_dev != rdev:
                            return {**res, "reason": f"protected: contains the mount point {e.path}"}
                        if isdir:
                            dirs.append(e.path)
                            dir_bytes += alloc_of(s)
                            stack.append(e.path)
                            continue
                        if stat.S_ISREG(s.st_mode):
                            files += 1
                            k = (s.st_dev, s.st_ino)
                            if k in inodes:
                                continue
                            rec = {"size": alloc_of(s), "nlink": s.st_nlink, "paths": [e.path]}
                            if s.st_nlink > 1:
                                rec["paths"] = self._verify_links(s, e.path, ix)
                            inodes[k] = rec
                        else:
                            dir_bytes += alloc_of(s)
            dir_bytes += alloc_of(st)
            res["files"] = files
        elif stat.S_ISREG(st.st_mode):
            res["kind"] = "file"
            dir_bytes = 0
            rec = {"size": alloc_of(st), "nlink": st.st_nlink, "paths": [path]}
            if st.st_nlink > 1:
                rec["paths"] = self._verify_links(st, path, ix)
            inodes[(st.st_dev, st.st_ino)] = rec
            res["files"] = 1
            res["ino"] = st.st_ino
            res["nlink"] = st.st_nlink
        else:
            res["kind"] = "link" if stat.S_ISLNK(st.st_mode) else "other"
            dir_bytes = 0
            res["files"] = 0
        # every hard link must be accounted for, and every one outside must be deletable
        external = []
        for k, rec in inodes.items():
            if len(rec["paths"]) < rec["nlink"]:
                return {**res, "reason": (
                    f"{rec['paths'][0]} has {rec['nlink']} hard links but only {len(rec['paths'])} could be found — "
                    "deleting would free nothing. The index is being refreshed; try again in a few minutes."),
                    "needsReindex": True}
            for p in rec["paths"]:
                if under(p, path):
                    continue
                pw = self.rules.check(p)
                if pw:
                    return {**res, "reason": f"protected: a hard link of {rec['paths'][0]} lives at {p} ({pw})"}
                external.append(p)
        res["externalLinks"] = sorted(set(external))
        res["bytes"] = sum(r["size"] for r in inodes.values()) + dir_bytes
        res["sharedInodes"] = sum(1 for r in inodes.values() if r["nlink"] > 1)
        res["ok"] = True
        res["_inodes"] = inodes
        return res

    def preview(self, paths):
        if not isinstance(paths, list) or not paths:
            raise ValueError("Nothing selected.")
        if len(paths) > 500:
            raise ValueError("Too many items at once (max 500).")
        if not all(isinstance(p, str) for p in paths):
            raise ValueError("Paths must be strings.")
        self.rules.refresh_dynamic()   # mounts + running containers' binds, as of now
        normed = []
        for p in paths:
            try:
                normed.append(norm(p))
            except ValueError:
                normed.append(p)
        # a selection inside another selected folder is covered by that folder
        uniq = sorted(set(normed), key=len)
        targets = []
        for p in uniq:
            if not any(isinstance(t, str) and under(p, t) for t in targets):
                targets.append(p)
        analyses = [self.analyze(p) for p in targets]
        wanted = {}
        for a in analyses:
            for k in (a.get("_inodes") or {}):
                wanted[k] = a["path"]
        holders = open_holders(set(wanted))
        seen = set()
        total = 0
        held = 0
        for a in analyses:
            a["heldOpen"] = []
            if not a["ok"]:
                continue
            b = 0
            for k, rec in a["_inodes"].items():
                if k in seen:
                    continue
                seen.add(k)
                b += rec["size"]
                if k in holders:
                    held += rec["size"]
                    a["heldOpen"].append({"file": rec["paths"][0], "size": rec["size"], "by": holders[k][:5]})
            dirb = a["bytes"] - sum(r["size"] for r in a["_inodes"].values())
            a["bytes"] = b + dirb
            total += a["bytes"]
        plan_id = uuid.uuid4().hex
        self.plans = {k: v for k, v in self.plans.items() if v["at"] > time.time() - PLAN_TTL}
        self.plans[plan_id] = {"at": time.time(), "targets": targets, "total": total}
        public = [{k: v for k, v in a.items() if not k.startswith("_")} for a in analyses]
        return {
            "planId": plan_id, "targets": public, "totalBytes": total, "heldOpenBytes": held,
            "needsTypedConfirm": total > TYPED_CONFIRM_BYTES, "confirmWord": CONFIRM_WORD,
            "refused": sum(1 for a in analyses if not a["ok"]),
        }

    # -- deleting --
    def delete(self, plan_id, confirm=None, actor="unknown"):
        plan = self.plans.get(plan_id)
        if not plan or plan["at"] < time.time() - PLAN_TTL:
            raise ValueError("This delete plan expired — review the selection again.")
        if not self.lock.acquire(timeout=1):
            raise ValueError("Another delete is running — try again when it finishes.")
        try:
            # re-verify EVERYTHING against the disk as it is now
            analyses = [self.analyze(p) for p in plan["targets"]]
            total = sum(a.get("bytes", 0) for a in analyses if a["ok"])
            if max(total, plan["total"]) > TYPED_CONFIRM_BYTES and confirm != CONFIRM_WORD:
                raise ValueError(f"More than 1 GB — type {CONFIRM_WORD} to confirm.")
            wanted = {}
            for a in analyses:
                for k in (a.get("_inodes") or {}):
                    wanted[k] = True
            holders = open_holders(set(wanted))
            os.sync()
            before = disk_free(self.root)
            results = []
            removed_paths = []
            bytes_by_target = {}
            freed_expected = 0
            held_bytes = 0
            for a in analyses:
                r = {"path": a["path"], "ok": False}
                if not a["ok"]:
                    r["error"] = a.get("reason", "refused")
                    results.append(r)
                    continue
                errors = []
                removed_links = []
                # 1. hard links that live OUTSIDE the target (re-verified by inode)
                for k, rec in a["_inodes"].items():
                    for p in rec["paths"]:
                        if under(p, a["path"]):
                            continue
                        try:
                            s = os.lstat(p)
                            if (s.st_dev, s.st_ino) != k:
                                errors.append(f"{p}: changed since it was checked — left alone")
                                continue
                            os.unlink(p)
                            removed_links.append(p)
                            removed_paths.append(p)
                        except FileNotFoundError:
                            pass
                        except OSError as e:
                            errors.append(f"{p}: {e.strerror}")
                # 2. the target itself
                try:
                    s = os.lstat(a["path"])
                    if a["kind"] == "dir" and stat.S_ISDIR(s.st_mode):
                        def onerr(fn, p, exc):
                            errors.append(f"{p}: {exc[1]}")
                        shutil.rmtree(a["path"], onerror=onerr)
                    elif a["kind"] == "file":
                        k = next(iter(a["_inodes"]))
                        if (s.st_dev, s.st_ino) != k:
                            errors.append("changed since it was checked — left alone")
                        else:
                            os.unlink(a["path"])
                    elif a["kind"] in ("link", "other") and not stat.S_ISDIR(s.st_mode):
                        os.unlink(a["path"])
                    else:
                        errors.append("changed type since it was checked — left alone")
                except FileNotFoundError:
                    pass
                except OSError as e:
                    errors.append(f"{a['path']}: {e.strerror}")
                removed_paths.append(a["path"])
                held = [{"file": rec["paths"][0], "size": rec["size"], "by": holders[k][:5]}
                        for k, rec in a["_inodes"].items() if k in holders]
                hb = sum(h["size"] for h in held)
                held_bytes += hb
                freed_expected += a["bytes"]
                bytes_by_target[a["path"]] = a["bytes"]
                still = os.path.lexists(a["path"])
                r.update(ok=not still and not errors, kind=a["kind"], bytes=a["bytes"], files=a.get("files", 0),
                         removedLinks=removed_links, heldOpen=held, errors=errors[:20], stillExists=still)
                results.append(r)
                self._log({
                    "at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "actor": actor, "path": a["path"],
                    "kind": a["kind"], "bytes": a["bytes"], "files": a.get("files", 0),
                    "ino": a.get("ino"), "nlink": a.get("nlink"), "externalLinks": removed_links,
                    "heldOpenBytes": hb, "errors": errors[:20], "ok": r["ok"],
                })
            after = self._settled_free(before)
            freed = after["bfree"] - before["bfree"]
            if self.index and removed_paths:
                self.index.forget(removed_paths, bytes_by_target)
            self.plans.pop(plan_id, None)
        finally:
            self.lock.release()
        if removed_paths:
            self.refresh()   # the patched index is approximate; a fresh walk makes it exact
        return {
            "results": results, "expectedBytes": freed_expected, "freedBytes": freed,
            "heldOpenBytes": held_bytes, "disk": after,
        }

    def _settled_free(self, before):
        """statfs after the unlinks, given ext4 a moment to return the extents."""
        last = None
        for _ in range(6):
            os.sync()
            cur = disk_free(self.root)
            if last is not None and cur["bfree"] == last["bfree"]:
                return cur
            last = cur
            time.sleep(0.3)
        return last

    def _log(self, entry):
        line = json.dumps(entry) + "\n"
        fd = os.open(self.log_path, os.O_WRONLY | os.O_APPEND | os.O_CREAT, 0o600)
        try:
            os.write(fd, line.encode("utf-8", "surrogateescape"))
        finally:
            os.close(fd)


# ───────────────────────────── HTTP over a unix socket ─────────────────────────────

class UnixHTTPServer(socketserver.ThreadingMixIn, socketserver.UnixStreamServer):
    daemon_threads = True
    allow_reuse_address = True


def make_handler(agent):
    class H(http.server.BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def address_string(self):
            return "lab"

        def log_message(self, fmt, *args):
            sys.stderr.write("[http] " + (fmt % args) + "\n")

        def _send(self, code, obj):
            body = json.dumps(obj).encode("utf-8", "surrogateescape")
            self.send_response(code)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def _body(self):
            n = int(self.headers.get("Content-Length") or 0)
            if n > 2_000_000:
                raise ValueError("request too large")
            return json.loads(self.rfile.read(n) or b"{}") if n else {}

        def _route(self, method):
            u = urlparse(self.path)
            q = {k: v[0] for k, v in parse_qs(u.query).items()}
            try:
                if method == "GET" and u.path == "/status":
                    return self._send(200, agent.status())
                if method == "GET" and u.path == "/summary":
                    return self._send(200, agent.summary())
                if method == "GET" and u.path == "/tree":
                    return self._send(200, agent.tree(q.get("path", "/")))
                if method == "GET" and u.path == "/type":
                    return self._send(200, agent.by_type(q.get("type", "")))
                if method == "GET" and u.path == "/log":
                    return self._send(200, {"entries": agent.log_tail(int(q.get("limit", 50)))})
                if method == "POST" and u.path == "/refresh":
                    return self._send(200, {"started": agent.refresh(), **agent.status()})
                if method == "POST" and u.path == "/preview":
                    b = self._body()
                    return self._send(200, agent.preview(b.get("paths")))
                if method == "POST" and u.path == "/delete":
                    b = self._body()
                    return self._send(200, agent.delete(b.get("planId"), b.get("confirm"), str(b.get("actor") or "unknown")[:200]))
                return self._send(404, {"error": "not found"})
            except ValueError as e:
                return self._send(400, {"error": str(e)})
            except Exception as e:
                traceback.print_exc()
                return self._send(500, {"error": str(e)})

        def do_GET(self):
            self._route("GET")

        def do_POST(self):
            self._route("POST")

    return H


def main():
    os.makedirs(SOCK_DIR, exist_ok=True)
    os.chmod(STATE_DIR, 0o700)
    os.chmod(SOCK_DIR, 0o700)
    agent = Agent()
    agent.load_cached()
    if not agent.index or time.time() - agent.index.built_at > STALE_AT_START:
        agent.refresh()

    def periodic():
        while True:
            time.sleep(300)
            agent.rules.refresh_dynamic()
            ix = agent.index
            if not agent.scanning and (not ix or time.time() - ix.built_at > REFRESH_EVERY):
                agent.refresh()
    threading.Thread(target=periodic, daemon=True).start()

    try:
        os.unlink(SOCK_PATH)
    except FileNotFoundError:
        pass
    srv = UnixHTTPServer(SOCK_PATH, make_handler(agent))
    os.chmod(SOCK_PATH, 0o600)
    # the delete log is append-only at the filesystem level too (best effort)
    try:
        if not os.path.exists(LOG_PATH):
            os.close(os.open(LOG_PATH, os.O_WRONLY | os.O_CREAT, 0o600))
        import subprocess
        subprocess.run(["chattr", "+a", LOG_PATH], check=False, capture_output=True)
    except OSError:
        pass
    print(f"storage-agent listening on {SOCK_PATH}", flush=True)
    srv.serve_forever()


if __name__ == "__main__":
    main()
