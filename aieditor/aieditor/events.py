"""The job's structured event log — what the Lab shows as the live per-stage log.

Jake 2026-10-08: "Be transparent about each part of the process in the UI — show a
progress bar and a full log of each process." The worker installs a SINK for the job
it is running (bin/aieditor-worker, Job._event); every module below it reports through
the helpers here and never needs to know which job or stage it is in:

  emit(kind, msg, ...)   any event
  api(model, usd, ...)   one paid API call (model, $, tokens, seconds)
  proc(label)            a sub-process (a docker run: render, recorder, aligner…) —
                         context manager: start, then done with seconds, or failed
  scope(sub)             context manager: every event inside carries `sub` (e.g.
                         "screencast 2/5") so the Lab can group a stage's sub-processes

The sink writes one JSON object per line to <job>/events.jsonl:
  {"t": epoch, "stage": "graphics", "kind": "log|progress|api|proc|step|stage",
   "level": "info|warn|error", "msg": "...", "sub": "...", ...extra}

⚠️ Reporting must never break a job: with no sink (tests, a module run by hand) every
helper is a no-op, and a sink that raises is swallowed.
"""
import contextlib
import threading
import time

_SINK = None
_LOCAL = threading.local()


def set_sink(fn):
    """fn(event: dict) or None. The worker sets it per job."""
    global _SINK
    _SINK = fn


def set_sub(sub):
    """A loop's current item (e.g. "screencast 2/5") without a with-block; None clears.
    The worker clears it at every stage start."""
    _LOCAL.fixed = str(sub) if sub else None


def current_sub():
    parts = [p for p in [getattr(_LOCAL, "fixed", None)] + list(getattr(_LOCAL, "subs", None) or []) if p]
    return " · ".join(parts) if parts else None


def emit(kind, msg, level="info", **extra):
    if _SINK is None:
        return
    ev = {"t": round(time.time(), 3), "kind": kind, "level": level, "msg": str(msg)[:4000]}
    sub = extra.pop("sub", None) or current_sub()
    if sub:
        ev["sub"] = sub
    ev.update({k: v for k, v in extra.items() if v is not None})
    try:
        _SINK(ev)
    except Exception:                                   # noqa: BLE001
        pass


def api(model, usd=None, seconds=None, what="", usage=None, level="info"):
    """One paid API call. usage = the provider's usage dict (tokens)."""
    u = usage or {}
    toks = {k: u.get(k) for k in ("input_tokens", "output_tokens", "cache_read_input_tokens",
                                   "cache_creation_input_tokens") if u.get(k)}
    parts = [what or "API call", model]
    if usd is not None:
        parts.append(f"${usd:.4f}")
    if seconds is not None:
        parts.append(f"{seconds:.1f}s")
    if toks.get("input_tokens") or toks.get("output_tokens"):
        parts.append(f"{toks.get('input_tokens', 0)} in / {toks.get('output_tokens', 0)} out tokens")
    emit("api", " — ".join(parts), level=level, model=model,
         usd=round(usd, 5) if usd is not None else None,
         secs=round(seconds, 2) if seconds is not None else None, tokens=toks or None)


@contextlib.contextmanager
def scope(sub):
    subs = getattr(_LOCAL, "subs", None)
    if subs is None:
        subs = _LOCAL.subs = []
    subs.append(str(sub))
    try:
        yield
    finally:
        subs.pop()


@contextlib.contextmanager
def proc(label, detail=None):
    """A sub-process (a docker container). Logs start, then done/failed with seconds."""
    t0 = time.time()
    emit("proc", f"{label} — started" + (f" ({detail})" if detail else ""), proc=label, phase="start")
    try:
        yield
    except InterruptedError:
        emit("proc", f"{label} — stopped (cancelled) after {time.time() - t0:.1f}s", level="warn",
             proc=label, phase="cancelled", secs=round(time.time() - t0, 2))
        raise
    except BaseException as exc:
        name = type(exc).__name__
        level = "warn" if "Cancel" in name else "error"
        emit("proc", f"{label} — {'stopped' if level == 'warn' else 'FAILED'} after {time.time() - t0:.1f}s: {str(exc)[:600]}",
             level=level, proc=label, phase="failed", secs=round(time.time() - t0, 2))
        raise
    emit("proc", f"{label} — done in {time.time() - t0:.1f}s", proc=label, phase="done",
         secs=round(time.time() - t0, 2))


def level_of(msg):
    """A plain log line's level, for lines that do not say it themselves."""
    m = str(msg)
    low = m.lower()
    if m.startswith("FAILED") or "traceback" in low or " error" in low[:200]:
        return "error"
    if any(w in low for w in ("failed", "dropped", "stopped early", "warning", "retry", "retrying",
                              "trying again", "not enough", "skipped", "restarting")):
        return "warn"
    return "info"
