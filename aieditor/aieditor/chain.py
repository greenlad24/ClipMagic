"""ONE SUBMISSION = A FINISHED EDIT — the cut → creative chain (Jake 2026-10-09: "when a job is being
submitted for a new video - I don't want a review step from my side - everything should be made
automatically").

The Lab's "Full edit: raw narration → finished video" card writes ONE cut job (workflow "cut", the
factory takes policy, no_edit) whose request.json carries "chain": "creative" plus the creative
inputs (format, sponsored, script, sites, run_on). From then on nothing waits for Jake: the review
screen stays available, but no step of this file reads it.

    cut job (chain: "creative")
      run/recut done, wordiff.json = factory policy + 0 unapproved removals (the automatic word check)
          → queue "final" on the cut job, so the creative edit starts from SOURCE quality
      failed on the word check (the worker's narration-integrity stop)
          → re-cut ONCE under the factory policy (plan.json archived → new takes call, queue "recut");
            a second failure → the job ends HELD with its reasons (never a question to Jake)
      final-01.mp4 exists
          → a NEW creative job: source {kind: job, job: <cut>, file: final-01.mp4}, the carried
            inputs, title "<title> — edit", "chained_from": <cut>; its "run" is queued
    creative job (chained_from)
      run done and not held (its quality gates passed) but no final-01.mp4 (the final is a separate
      action on the main box; a factory-mode compose already renders it)
          → queue "final" on the creative job

Rules: never trims a pause, never adds a cut (a re-cut is a fresh takes call under the FACTORY policy,
which only removes retakes / false starts / whitelisted fillers and is word-checked again). Every step
is logged in BOTH jobs' log.txt and events.jsonl as "chain: …". State lives in <job>/chain.json, so
a step is taken once, survives a worker restart, and the tick is idempotent.

Runs ONLY from the worker's main loop on the main box (tick), never inside `--once` on a droplet: a
droplet sees one job folder and cannot create another job.
"""
import json
import os
import re
import secrets
import time
from pathlib import Path

from . import gates

CHAIN = "chain.json"
MAX_RECUTS = 1
FINAL = "final-01.mp4"
NARRATION_REASON = "narration integrity"
BUSY = ("running", "queued")


def _jload(path, default=None):
    try:
        return json.loads(Path(path).read_text())
    except (OSError, ValueError):
        return default


def _jdump(path, obj):
    tmp = Path(str(path) + ".tmp")
    tmp.write_text(json.dumps(obj, indent=1))
    os.replace(tmp, path)


def _now():
    return time.time()


def note(d, msg, level="info"):
    """One chain line in the job's log.txt and events.jsonl (stage "job": the Lab's job-level log)."""
    d = Path(d)
    line = "chain: " + msg
    with open(d / "log.txt", "a") as f:
        f.write(time.strftime("%Y-%m-%d %H:%M:%S ") + line + "\n")
    with open(d / "events.jsonl", "a") as f:
        f.write(json.dumps({"t": round(_now(), 3), "stage": "job", "kind": "log", "level": level, "msg": line},
                           ensure_ascii=False) + "\n")


def state_of(d):
    return _jload(Path(d) / CHAIN, {}) or {}


def _save_state(d, doc):
    _jdump(Path(d) / CHAIN, {**doc, "updated_at": round(_now(), 3)})


def _step(d, doc, step, **kw):
    doc = {**doc, **kw, "step": step}
    doc.setdefault("steps", [])
    doc["steps"] = list(doc["steps"]) + [{"step": step, "t": round(_now(), 3)}]
    _save_state(d, doc)
    return doc


def _queue(d, action):
    _jdump(Path(d) / "queue.json", {"action": action})


def word_check(d):
    """The automatic gate: a factory-policy cut whose word-diff found 0 unapproved removals.
    -> (ok, wordiff doc or None)."""
    wd = _jload(Path(d) / "wordiff.json")
    if not isinstance(wd, dict):
        return False, None
    ok = wd.get("policy") == "factory" and wd.get("unapproved") == 0 and "approved_by" in wd
    return ok, wd


def is_chain_cut(req):
    return (req or {}).get("chain") == "creative" and (req or {}).get("workflow", "cut") != "creative"


def is_chained_creative(req):
    return (req or {}).get("workflow") == "creative" and bool((req or {}).get("chained_from"))


def _busy(d, st, running):
    if (Path(d) / "queue.json").exists():
        return True
    if (st or {}).get("state") in BUSY:
        return True
    return bool(running and running(Path(d).name))


def _slug(text):
    s = re.sub(r"[^a-z0-9]+", "-", str(text or "").lower()).strip("-")[:30].strip("-")
    return s or "edit"


def new_creative_id(jobs_root, title):
    stamp = time.strftime("%m%d%H%M", time.gmtime())
    for _ in range(20):
        jid = f"{_slug(title)}-{stamp}-{secrets.token_hex(2)}"
        if not (Path(jobs_root) / jid).exists():
            return jid
    raise RuntimeError("no free job id")


def creative_request(cut_id, cut_req, title, jid):
    """request.json of the chained creative job: the carried inputs, the cut's final as its source."""
    return {
        "id": jid,
        "source": {"kind": "job", "job": cut_id, "file": FINAL, "title": title},
        "workflow": "creative",
        "format": cut_req.get("format"),
        "sponsored": cut_req.get("sponsored"),
        "script": cut_req.get("script"),
        "title": f"{title} — edit"[:120],
        "sites": cut_req.get("sites") or [],
        "run_on": cut_req.get("run_on") or "auto",
        "chained_from": cut_id,
        **({"music": cut_req["music"]} if isinstance(cut_req.get("music"), dict) else {}),   # aieditor/music.py
        "created_at": _now(),
    }


def create_creative(jobs_root, cut_dir, cut_req):
    """The creative job folder + its queued "run". -> the new job id."""
    cut_dir = Path(cut_dir)
    src = _jload(cut_dir / "source.json", {}) or {}
    title = cut_req.get("title") or src.get("title") or cut_dir.name
    jid = new_creative_id(jobs_root, f"{title} edit")
    d = Path(jobs_root) / jid
    d.mkdir(parents=True)
    _jdump(d / "request.json", creative_request(cut_dir.name, cut_req, title, jid))
    _jdump(d / "status.json", {"state": "queued", "message": f"Queued by the chain from {cut_dir.name}",
                               "stages": {}, "workflow": "creative", "cost_usd": 0, "updated_at": _now()})
    _queue(d, "run")
    return jid


def hold(d, why, remedies):
    """The job ends HELD with its reasons (recommendation §4: never shipped quietly, never notes for Jake)."""
    d = Path(d)
    doc = gates.held_doc(d)
    item = {"reason": NARRATION_REASON, "detail": why}
    if item not in doc["reasons"]:
        doc["reasons"].append(item)
    (d / gates.HELD).write_text(json.dumps(doc, indent=1))
    failures = [gates.failure("narration", why, remedies_tried=remedies)]
    st = _jload(d / "status.json", {}) or {}
    st.update(state="held", held=True, held_reasons=doc["reasons"], held_failures=failures,
              message=f"Held — {NARRATION_REASON}: {why}"[:500], error=None, progress=1,
              finished_at=_now(), updated_at=_now())
    _jdump(d / "status.json", st)


def _recut(d, doc, wd):
    """Archive the failed takes plan (so the worker asks for fresh takes under the factory policy) and
    queue "recut" (it rebuilds the cut and runs the word check again)."""
    d = Path(d)
    n = int(doc.get("recuts") or 0) + 1
    for f in ("plan.json", "plan.raw.json"):
        if (d / f).exists():
            os.replace(d / f, d / f"{Path(f).stem}.recut-{n}.json")
    doc = _step(d, doc, "recut", recuts=n)
    _queue(d, "recut")
    note(d, f"word check failed ({wd.get('unapproved')} unapproved removal(s), "
            f"{wd.get('unapproved_words', '?')} word(s)) — re-cut {n} of {MAX_RECUTS} under the factory policy queued",
         "warn")
    return doc


def advance_cut(jobs_root, d, req, running=None):
    """One chain step for a cut job with "chain": "creative". -> what was done (str) or None."""
    d = Path(d)
    st = _jload(d / "status.json", {}) or {}
    if _busy(d, st, running):
        return None
    doc = state_of(d)
    if doc.get("next") or doc.get("held"):
        return None
    state = st.get("state")
    ok, wd = word_check(d)
    if state == "done":
        if (d / FINAL).is_file():
            jid = create_creative(jobs_root, d, req)
            _step(d, doc, "creative", next=jid)
            note(d, f"{FINAL} ready — creative edit {jid} created and queued")
            note(Path(jobs_root) / jid, f"started from the cut {d.name} ({FINAL}); run queued")
            return f"creative {jid}"
        if ok:
            if doc.get("step") == "final" and st.get("action") == "final":
                # the final ran and made no file: nothing more to chain on, held with the reason
                hold(d, f"the final render produced no {FINAL}", ["final"])
                _step(d, doc, "held", held=True)
                note(d, f"final finished without {FINAL} — held", "error")
                return "held"
            _step(d, doc, "final")
            _queue(d, "final")
            note(d, f"word check passed ({wd.get('removals', 0) if wd else 0} approved removal(s), "
                    f"0 unapproved) — final queued so the creative edit starts from source quality")
            return "final"
        # done but the word check did not pass (a cut without a factory word-diff): treat as a failure
    if state in ("done", "failed") and wd is not None and not ok:
        if int(doc.get("recuts") or 0) < MAX_RECUTS:
            _recut(d, doc, wd)
            return "recut"
        why = (f"{wd.get('unapproved')} unapproved removal(s) after {doc.get('recuts')} automatic re-cut(s) "
               f"under the factory policy (see wordiff.json)")
        hold(d, why, ["recut"] * int(doc.get("recuts") or 0))
        _step(d, doc, "held", held=True)
        note(d, f"word check failed again — held: {why}", "error")
        return "held"
    return None


def advance_creative(jobs_root, d, req, running=None):
    """One chain step for a chained creative job: its final, once its quality gates passed."""
    d = Path(d)
    st = _jload(d / "status.json", {}) or {}
    if _busy(d, st, running):
        return None
    doc = state_of(d)
    if doc.get("done") or st.get("state") != "done" or st.get("held"):
        return None
    cut = str(req.get("chained_from"))
    cut_dir = Path(jobs_root) / cut
    if (d / FINAL).is_file():
        _step(d, doc, "finished", done=True)
        note(d, f"finished video ready: {FINAL}")
        if cut_dir.is_dir():
            note(cut_dir, f"the creative edit {d.name} finished: {FINAL}")
        return "finished"
    if doc.get("step") == "final":
        if st.get("action") == "final":
            _step(d, doc, "no-final", done=True)
            note(d, f"final finished without {FINAL} (a held draft gets no final) — chain stopped", "warn")
            return "no-final"
        return None
    _step(d, doc, "final")
    _queue(d, "final")
    note(d, "quality gates passed — final queued")
    if cut_dir.is_dir():
        note(cut_dir, f"the creative edit {d.name} passed its gates — its final is queued")
    return "final"


def tick(jobs_root, running=None, log=lambda m: None):
    """Advance every chained job one step. `running(job_id)` -> True while a factory server has it.
    Never raises (the worker loop must keep claiming)."""
    done = []
    try:
        dirs = sorted(p for p in Path(jobs_root).iterdir() if p.is_dir() and not p.name.startswith("_"))
    except OSError:
        return done
    for d in dirs:
        req = _jload(d / "request.json")
        if not isinstance(req, dict):
            continue
        try:
            if is_chain_cut(req):
                r = advance_cut(jobs_root, d, req, running)
            elif is_chained_creative(req):
                r = advance_creative(jobs_root, d, req, running)
            else:
                continue
        except Exception as exc:                          # noqa: BLE001 — one bad folder never stops the loop
            log(f"chain: {d.name}: {exc}")
            continue
        if r:
            done.append((d.name, r))
            log(f"chain: {d.name}: {r}")
    return done
