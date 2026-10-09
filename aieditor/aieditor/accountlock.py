"""One job at a time per logged-in account (architecture recommendation §3.7).

Two jobs in one ChatGPT account at once see each other's chats, generations and rate limits (and an
"Unusual activity" block hits both). The dispatcher on the main box (cloud.run_remote) therefore locks
every Scout account a job will use BEFORE it leases a droplet, and releases them when the job ends.
A second job for the same account waits; the worker leaves it queued while the lock is held (busy()).

The lock is fcntl.flock on WORK/locks/<slug>.lock — the kernel drops it if the holder dies, so a
crashed worker never leaves an account locked. The file also says who holds it (for the log/Lab).
"""
import fcntl
import json
import os
import re
import time
from pathlib import Path

from . import config

LOCKS = config.WORK / "locks"


def _path(slug):
    safe = re.sub(r"[^A-Za-z0-9._-]", "_", str(slug))[:80] or "_"
    return LOCKS / f"{safe}.lock"


def holder(slug):
    try:
        return json.loads(_path(slug).read_text() or "{}")
    except (OSError, ValueError):
        return {}


def busy(slug):
    """True while another process/file handle holds the account (a probe; never blocks)."""
    p = _path(slug)
    if not p.exists():
        return False
    try:
        fd = os.open(p, os.O_RDWR)
    except OSError:
        return False
    try:
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        return True
    else:
        fcntl.flock(fd, fcntl.LOCK_UN)
        return False
    finally:
        os.close(fd)


class AccountLock:
    """Locks a job's Scout accounts (all or nothing, sorted order: no deadlock)."""

    def __init__(self, slugs, job):
        self.slugs = sorted({s for s in slugs or [] if s})
        self.job = job
        self.fds = {}

    def try_acquire(self):
        """All accounts now, or none: returns the slug that is busy (None = all locked)."""
        LOCKS.mkdir(parents=True, exist_ok=True)
        for slug in self.slugs:
            if slug in self.fds:
                continue
            fd = os.open(_path(slug), os.O_RDWR | os.O_CREAT, 0o644)
            try:
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                os.close(fd)
                self.release()
                return slug
            os.ftruncate(fd, 0)
            os.write(fd, json.dumps({"job": self.job, "pid": os.getpid(), "since": time.time()}).encode())
            self.fds[slug] = fd
        return None

    def acquire(self, wait=False, cancelled=lambda: False, log=print, poll=10, timeout=None):
        """True once every account is locked. wait=False: one try. wait=True: until free,
        cancelled() or timeout (seconds)."""
        t0 = time.time()
        said = None
        while True:
            busy_slug = self.try_acquire()
            if busy_slug is None:
                if self.slugs:
                    log(f"account lock: {', '.join(self.slugs)} held by this job")
                return True
            if not wait or cancelled() or (timeout is not None and time.time() - t0 > timeout):
                return False
            if said != busy_slug:
                h = holder(busy_slug)
                log(f"waiting for the {busy_slug} account — job {h.get('job', '?')} is using it "
                    "(one job per logged-in account)")
                said = busy_slug
            time.sleep(poll)

    def release(self):
        for slug, fd in list(self.fds.items()):
            try:
                os.ftruncate(fd, 0)
                fcntl.flock(fd, fcntl.LOCK_UN)
            finally:
                os.close(fd)
            self.fds.pop(slug, None)

    def __enter__(self):
        if not self.acquire():
            raise RuntimeError("account busy")
        return self

    def __exit__(self, *a):
        self.release()
