"""The Claude API spending ledger and its caps (architecture recommendation step 1).

Every paid Claude call goes through aieditor/llm.py, which asks check() BEFORE sending and calls
record() after. One JSON line per call in config.API_LEDGER:

    {"id", "ts", "job", "stage", "model", "in", "out", "cache_read", "cache_write", "usd", "ok", "purpose"}

Caps (WORK/factory.json, next to the $20/24 h server cap — cloud.DEFAULTS):
  api_job_cap_usd    {"creative": 8, "cut": 1}   all calls of one job, every run of it
  api_daily_cap_usd  30                          rolling 24 h, every job (Jake decision 1: PENDING —
                                                 api_daily_cap_pending_jake stays true until he sets it)

A call that WOULD pass a cap is refused before it is sent: BudgetExceeded. Inside a job that ends the
job with held reason "API cap" (bin/aieditor-worker); the worker does not start a job while the daily
cap is reached (the same queue behaviour as cloud.over_daily_cap).

On a factory server the main box's ledger is not there: cloud.run_remote ships the caps and what was
already spent (AIEDITOR_API_* below) and points config.API_LEDGER at <job>/api-ledger.jsonl, which it
merges back into the main ledger when the job ends (merge(); line ids make that idempotent).
"""
import json
import os
import threading
import time
import uuid
from pathlib import Path

from . import config

DAY = 86400
DEFAULT_JOB_CAPS = {"creative": 8.0, "cut": 1.0}
DEFAULT_DAILY_CAP = 30.0
# env a factory server gets from cloud.run_remote (the main box reads its settings instead)
ENV_JOB_CAP = "AIEDITOR_API_JOB_CAP_USD"
ENV_DAILY_CAP = "AIEDITOR_API_DAILY_CAP_USD"
ENV_PRIOR_DAY = "AIEDITOR_API_PRIOR_24H_USD"       # main-box rolling 24 h at dispatch
ENV_PRIOR_JOB = "AIEDITOR_API_PRIOR_JOB_USD"       # this job's earlier runs
ENV_DAY_START = "AIEDITOR_API_PRIOR_AT"            # when the prior figure was taken
_lock = threading.Lock()


class BudgetExceeded(RuntimeError):
    """A call refused before it was sent. reason is the held reason the job ends with."""
    reason = "API cap"

    def __init__(self, msg, which):
        super().__init__(msg)
        self.which = which                  # "job" | "daily"


def path():
    return Path(os.environ.get("AIEDITOR_API_LEDGER") or config.API_LEDGER)


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


def record(row, p=None):
    p = Path(p) if p else path()
    row = {"id": row.get("id") or uuid.uuid4().hex, **row}
    with _lock:
        p.parent.mkdir(parents=True, exist_ok=True)
        with open(p, "a") as f:
            f.write(json.dumps(row) + "\n")
    return row


def _env_float(name):
    try:
        v = os.environ.get(name)
        return float(v) if v not in (None, "") else None
    except ValueError:
        return None


def caps(workflow="cut"):
    """(job cap, daily cap) in $. A factory server uses what the dispatcher shipped."""
    job_cap, day_cap = _env_float(ENV_JOB_CAP), _env_float(ENV_DAILY_CAP)
    if job_cap is None or day_cap is None:
        s = {}
        try:
            from . import cloud
            s = cloud.settings()
        except Exception:                                   # noqa: BLE001 — caps must never break a job
            pass
        jc = s.get("api_job_cap_usd") or DEFAULT_JOB_CAPS
        if job_cap is None:
            job_cap = float((jc.get(workflow) if isinstance(jc, dict) else jc) or DEFAULT_JOB_CAPS.get(workflow, 1.0))
        if day_cap is None:
            day_cap = float(s.get("api_daily_cap_usd") or DEFAULT_DAILY_CAP)
    return job_cap, day_cap


def daily_total(now=None, p=None):
    """Rolling 24 h $ of every job. On a factory server: the main box's figure at dispatch plus
    what this server has spent since (its ledger holds only this run's lines)."""
    now = now or time.time()
    usd = sum(float(r.get("usd") or 0) for r in rows(p) if (r.get("ts") or 0) > now - DAY)
    prior = _env_float(ENV_PRIOR_DAY)
    if prior:
        at = _env_float(ENV_DAY_START) or now
        if at > now - DAY:
            usd += prior
    return usd


def job_total(job, p=None):
    usd = sum(float(r.get("usd") or 0) for r in rows(p) if r.get("job") == job)
    return usd + (_env_float(ENV_PRIOR_JOB) or 0.0)


def check(job, est_usd, workflow=None, now=None):
    """Raise BudgetExceeded when this call (estimated est_usd) would pass the job cap or the
    rolling daily cap. A call with no job (a hand-run module) only meets the daily cap."""
    workflow = workflow or "cut"
    job_cap, day_cap = caps(workflow)
    if job:
        spent = job_total(job)
        if job_cap and spent + est_usd > job_cap:
            raise BudgetExceeded(f"API cap: this job has spent ${spent:.2f} of its ${job_cap:.2f} "
                                 f"({workflow}) and the next call needs about ${est_usd:.2f}", "job")
    day = daily_total(now)
    if day_cap and day + est_usd > day_cap:
        raise BudgetExceeded(f"API cap: ${day:.2f} spent on the Claude API in the last 24 h of the "
                             f"${day_cap:.2f} daily cap; the next call needs about ${est_usd:.2f}", "daily")


def over_daily_cap(now=None):
    """The worker's queue check: no new job starts while the rolling 24 h API spend is at the cap."""
    _, day_cap = caps()
    return bool(day_cap) and daily_total(now) >= day_cap


def merge(src, dst=None):
    """Append src's lines that dst does not hold yet (by id). Returns how many were added."""
    dst = Path(dst) if dst else Path(config.API_LEDGER)
    have = {r.get("id") for r in rows(dst)}
    new = [r for r in rows(src) if r.get("id") not in have]
    if new:
        with _lock:
            dst.parent.mkdir(parents=True, exist_ok=True)
            with open(dst, "a") as f:
                for r in new:
                    f.write(json.dumps(r) + "\n")
    return len(new)
