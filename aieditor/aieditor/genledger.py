"""The in-app GENERATION ledger: how many pictures the factory has asked an app's account for (Jake 2026-10-10).

Every generating press of the pre-production producer (aieditor/producer.py) is one line, per app, across jobs:

    WORK/ledger/generations.jsonl   {"id", "ts", "app", "job", "asset", "try", "route", "kind": "gen"}
                                    {"id", "ts", "app", "job", "kind": "block", "until", "why"}   (a wall / a limit)

Limits it enforces (rules.json onboarding.producer, defaults below):
  daily_generations   {"chatgpt": 35, "default": 35} per rolling 24 h per app, counted across jobs. At the cap the
                      producer raises QuotaWait: the job goes back to the queue with a clear status and a not_before
                      time (bin/aieditor-worker) — waiting, never held.
  spacing_s           >= 45 s between two generations of one app (across jobs too: the last line's ts).
  a block line        a wall or a usage-limit message stops EVERY generation of that app until "until".

On a factory server the main ledger is not there: cloud.run_remote ships the main box's recent lines of every app in
AIEDITOR_GEN_PRIOR (JSON) and points AIEDITOR_GEN_LEDGER at <job>/gen-ledger.jsonl, merged back when the job ends
(merge(); line ids make it idempotent) — the same pattern as apiledger.py.
"""
import json
import os
import threading
import time
import uuid
from pathlib import Path

from . import config

DAY = 86400
DEFAULT_CAPS = {"chatgpt": 35, "default": 35}
DEFAULT_SPACING_S = 45.0
ENV_LEDGER = "AIEDITOR_GEN_LEDGER"
ENV_PRIOR = "AIEDITOR_GEN_PRIOR"
_lock = threading.Lock()


class QuotaWait(RuntimeError):
    """No generation may start now (daily cap / a wall / a limit message). The job WAITS until resume_at."""

    def __init__(self, app, resume_at, why):
        super().__init__(why)
        self.app, self.resume_at, self.why = app, float(resume_at), why

    def status(self):
        bkk = time.strftime("%Y-%m-%d %H:%M", time.gmtime(self.resume_at + 7 * 3600))
        return f"Waiting: {self.why} — continues about {bkk} (Bangkok)"


def path():
    return Path(os.environ.get(ENV_LEDGER) or (config.WORK / "ledger" / "generations.jsonl"))


def _rules():
    try:
        from . import skill
        return (skill.rules().get("onboarding") or {}).get("producer") or {}
    except Exception:  # noqa: BLE001 — limits must never break a job
        return {}


def cap(app):
    c = _rules().get("daily_generations") or DEFAULT_CAPS
    return int(c.get(app, c.get("default", DEFAULT_CAPS["default"])))


def spacing():
    return float(_rules().get("spacing_s") or config.GEN_SPACING_S or DEFAULT_SPACING_S)


def rows(p=None):
    p = Path(p) if p else path()
    out = []
    try:
        with open(p) as f:
            for line in f:
                try:
                    r = json.loads(line)
                except ValueError:
                    continue
                if isinstance(r, dict):
                    out.append(r)
    except OSError:
        pass
    return out


def _prior():
    try:
        v = json.loads(os.environ.get(ENV_PRIOR) or "[]")
        return [r for r in v if isinstance(r, dict)]
    except ValueError:
        return []


def all_rows(app=None):
    seen, out = set(), []
    for r in rows() + _prior():
        if r.get("id") in seen:
            continue
        seen.add(r.get("id"))
        if app is None or r.get("app") == app:
            out.append(r)
    return out


def record(app, job=None, asset=None, try_=None, route=None, now=None):
    row = {"id": uuid.uuid4().hex, "ts": round(now or time.time(), 3), "app": app, "job": job, "asset": asset,
           "try": try_, "route": route, "kind": "gen"}
    _append(row)
    return row


def block(app, until, why, job=None, now=None):
    row = {"id": uuid.uuid4().hex, "ts": round(now or time.time(), 3), "app": app, "job": job, "kind": "block",
           "until": round(float(until), 3), "why": str(why)[:300]}
    _append(row)
    return row


def _append(row):
    p = path()
    with _lock:
        p.parent.mkdir(parents=True, exist_ok=True)
        with open(p, "a") as f:
            f.write(json.dumps(row) + "\n")


def used(app, now=None):
    now = now or time.time()
    return sorted(r["ts"] for r in all_rows(app) if r.get("kind") == "gen" and r.get("ts", 0) > now - DAY)


def blocked(app, now=None):
    """The latest active block line (a wall / a limit) or None."""
    now = now or time.time()
    act = [r for r in all_rows(app) if r.get("kind") == "block" and float(r.get("until") or 0) > now]
    return max(act, key=lambda r: r["until"]) if act else None


def remaining(app, now=None):
    return max(0, cap(app) - len(used(app, now)))


def gate(app, now=None):
    """Raise QuotaWait when no generation of this app may start now; else the seconds to wait for the spacing."""
    now = now or time.time()
    b = blocked(app, now)
    if b:
        raise QuotaWait(app, b["until"], f"{app} stopped generations: {b.get('why')}")
    u = used(app, now)
    if len(u) >= cap(app):
        resume = u[len(u) - cap(app)] + DAY + 60
        raise QuotaWait(app, resume, f"{app} daily generation limit reached ({len(u)}/{cap(app)} in 24 h)")
    last = u[-1] if u else None
    return max(0.0, spacing() - (now - last)) if last else 0.0


def ok_to_start(app, now=None):
    """The worker's queue check: (True, None) or (False, QuotaWait)."""
    try:
        gate(app, now)
        return True, None
    except QuotaWait as e:
        return False, e


def prior_env(now=None):
    """The main box's last-24 h lines of every app, for a factory server (cloud.api_env)."""
    now = now or time.time()
    keep = [r for r in all_rows() if r.get("ts", 0) > now - DAY or float(r.get("until") or 0) > now]
    slim = [{k: r[k] for k in ("id", "ts", "app", "kind", "until", "why") if k in r} for r in keep[-200:]]
    return json.dumps(slim, separators=(",", ":"))


def merge(src, dst=None):
    dst = Path(dst) if dst else (config.WORK / "ledger" / "generations.jsonl")
    have = {r.get("id") for r in rows(dst)}
    new = [r for r in rows(src) if r.get("id") not in have]
    if new:
        with _lock:
            dst.parent.mkdir(parents=True, exist_ok=True)
            with open(dst, "a") as f:
                for r in new:
                    f.write(json.dumps(r) + "\n")
    return len(new)
