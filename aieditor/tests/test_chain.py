"""ONE SUBMISSION = A FINISHED EDIT — the cut → creative chain (aieditor/chain.py), on a fake job tree in a
temp dir (no media, no API, no worker process). Jake 2026-10-09: "I don't want a review step from my side".

  pass      wordiff passes → "final" queued on the cut → final-01.mp4 → a creative job is created
            (source = the cut's final, carried inputs, "<title> — edit", chained_from) with its "run"
            queued → its gates pass → its "final" queued → finished; logged "chain: …" in both jobs
  fail      wordiff fails → plan archived + "recut" queued once → fails again → HELD with its reasons
  recover   a re-cut that passes goes on to the final like a first-time pass
  guards    a queued / running / factory-running job is never touched; ticks are idempotent; a job
            without "chain" is ignored; the chained creative source passes the automatic source gate
  worker    the tick runs from main() only, never from --once (a droplet cannot create jobs)

Run: python3 tests/test_chain.py
"""
import importlib.machinery
import importlib.util
import inspect
import json
import os
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
os.environ.setdefault("AIEDITOR_API_LEDGER", str(Path(tempfile.mkdtemp(prefix="chain-ledger-")) / "api.jsonl"))
from aieditor import chain, sources  # noqa: E402

N = 0


def check(cond, msg):
    global N
    N += 1
    if not cond:
        raise AssertionError(msg)


def jl(p, default=None):
    try:
        return json.loads(Path(p).read_text())
    except (OSError, ValueError):
        return default


def jw(p, obj):
    Path(p).write_text(json.dumps(obj))


CUT_REQ = {"workflow": "cut", "chain": "creative", "takes_policy": "factory", "no_edit": True,
           "format": "long", "sponsored": False, "script": "the script", "title": "Linearity tour",
           "sites": [{"url": "https://linearity.io/", "note": "the tool"}], "run_on": "auto",
           "source": {"kind": "descript", "url": "https://share.descript.com/view/AbC123xyz"}}

WD_OK = {"policy": "factory", "unapproved": 0, "unapproved_words": 0, "approved_by": None, "removals": 4}
WD_BAD = {"policy": "factory", "unapproved": 3, "unapproved_words": 7, "approved_by": None, "removals": 6}


def cut_job(jobs, name, state="done", action="run", wordiff=WD_OK):
    d = jobs / name
    d.mkdir()
    jw(d / "request.json", {**CUT_REQ, "id": name})
    jw(d / "status.json", {"state": state, "action": action, "stages": {}})
    jw(d / "source.json", {"title": "Linearity raw", "width": 3840, "height": 2160})
    jw(d / "plan.json", {"videos": []})
    jw(d / "plan.raw.json", {"answer": ""})
    jw(d / "edl.json", {"videos": [{"joins": [{"removed": "take one"}]}]})
    if wordiff is not None:
        jw(d / "wordiff.json", wordiff)
    return d


def finish(d, action, state="done", files=()):
    """What the worker leaves after running a queued action."""
    check((d / "queue.json").exists(), f"{d.name}: an action was queued")
    check(jl(d / "queue.json")["action"] == action, f"{d.name}: queued {action}: {jl(d / 'queue.json')}")
    (d / "queue.json").unlink()
    for f in files:
        (d / f).write_bytes(b"MP4!" + f.encode())
    st = jl(d / "status.json", {})
    st.update(state=state, action=action)
    jw(d / "status.json", st)


def chain_lines(d):
    log = (d / "log.txt").read_text() if (d / "log.txt").exists() else ""
    evs = [json.loads(x) for x in (d / "events.jsonl").read_text().splitlines()] if (d / "events.jsonl").exists() else []
    return [x for x in log.splitlines() if "chain: " in x], [e for e in evs if e["msg"].startswith("chain: ")]


def test_pass(jobs):
    cut = cut_job(jobs, "lin-raw-1009-aaaa")
    r = chain.tick(jobs)
    check(r == [(cut.name, "final")], f"word check passed → final queued: {r}")
    check(jl(cut / "queue.json") == {"action": "final"}, "final queued on the cut")
    check(chain.tick(jobs) == [], "a queued job is not touched again (idempotent)")
    st = jl(cut / "status.json"); st["state"] = "running"; jw(cut / "status.json", st)
    (cut / "queue.json").unlink()
    check(chain.tick(jobs) == [], "a running job is not touched")
    jw(cut / "queue.json", {"action": "final"})
    finish(cut, "final", files=["final-01.mp4"])
    r = chain.tick(jobs)
    check(len(r) == 1 and r[0][0] == cut.name and r[0][1].startswith("creative "), f"creative created: {r}")
    cid = chain.state_of(cut)["next"]
    cr = jobs / cid
    req = jl(cr / "request.json")
    check(req["workflow"] == "creative" and req["chained_from"] == cut.name, f"creative request {req}")
    check(req["source"] == {"kind": "job", "job": cut.name, "file": "final-01.mp4", "title": "Linearity tour"},
          f"source = the cut's final: {req['source']}")
    for k in ("format", "sponsored", "script", "sites", "run_on"):
        check(req[k] == CUT_REQ[k], f"carried input {k}: {req[k]!r}")
    check(req["title"] == "Linearity tour — edit", f"title {req['title']!r}")
    check(req["id"] == cid and sources.JOB_RE.match(cid), f"valid id {cid}")
    check(jl(cr / "queue.json") == {"action": "run"}, "its run is queued")
    check(jl(cr / "status.json")["state"] == "queued", "status queued")
    # the creative edit's source passes the automatic gate (no tick, no review)
    p, facts = sources.resolve(req["source"], jobs, self_id=cid)
    check(p == cut / "final-01.mp4" and facts["review"] == "final", f"source accepted automatically: {facts}")
    check(chain.tick(jobs) == [], "no second creative job")
    check(len([x for x in jobs.iterdir() if x.is_dir()]) == 2, "exactly one creative job")
    # creative: run done with gates passed → its final; then finished
    finish(cr, "run")
    check(chain.tick(jobs) == [(cid, "final")], "creative gates passed → its final queued")
    finish(cr, "final", files=["final-01.mp4"])
    check(chain.tick(jobs) == [(cid, "finished")], "finished")
    check(chain.tick(jobs) == [], "nothing more")
    log, evs = chain_lines(cut)
    check(len(log) >= 3 and len(evs) == len(log), f"cut job: chain lines in log + events: {log}")
    check(any("final queued" in x for x in log) and any(cid in x for x in log), f"cut log names the steps {log}")
    log2, evs2 = chain_lines(cr)
    check(any(f"started from the cut {cut.name}" in x for x in log2) and any("finished video ready" in x for x in log2),
          f"creative log {log2}")
    check(all(e["stage"] == "job" and e["kind"] == "log" for e in evs + evs2), "events are job-level log lines")
    steps = [s["step"] for s in chain.state_of(cut)["steps"]]
    check(steps == ["final", "creative"], f"cut chain.json steps {steps}")


def test_fail(jobs):
    cut = cut_job(jobs, "bad-raw-1009-bbbb", state="failed", wordiff=WD_BAD)
    r = chain.tick(jobs)
    check(r == [(cut.name, "recut")], f"word check failed → re-cut: {r}")
    check(jl(cut / "queue.json") == {"action": "recut"}, "recut queued")
    check(not (cut / "plan.json").exists() and (cut / "plan.recut-1.json").exists()
          and (cut / "plan.raw.recut-1.json").exists(), "the failed takes plan is archived (fresh takes call)")
    check(chain.state_of(cut)["recuts"] == 1, "one re-cut counted")
    finish(cut, "recut", state="failed")            # the second cut fails its word check too
    r = chain.tick(jobs)
    check(r == [(cut.name, "held")], f"second failure → held: {r}")
    st = jl(cut / "status.json")
    check(st["state"] == "held" and st["held"] is True, f"status held {st}")
    check(st["held_failures"][0]["dim"] == "narration" and st["held_failures"][0]["remedies_tried"] == ["recut"]
          and "3 unapproved" in st["held_failures"][0]["why"], f"failure list {st['held_failures']}")
    held = jl(cut / "held.json")
    check(held["reasons"][0]["reason"] == "narration integrity", f"held.json {held}")
    check(not (cut / "queue.json").exists(), "nothing queued after the hold")
    check(chain.tick(jobs) == [], "a held chain stays held")
    check(not any(x.name.startswith("linearity-tour-edit") and jl(x / "request.json", {}).get("chained_from") == cut.name
                  for x in jobs.iterdir()), "no creative job from a held cut")
    log, _ = chain_lines(cut)
    check(any("re-cut 1 of 1" in x for x in log) and any("held" in x for x in log), f"log {log}")


def test_recover(jobs):
    cut = cut_job(jobs, "ok2-raw-1009-cccc", state="failed", wordiff=WD_BAD)
    check(chain.tick(jobs) == [(cut.name, "recut")], "re-cut")
    jw(cut / "wordiff.json", WD_OK)
    finish(cut, "recut")
    check(chain.tick(jobs) == [(cut.name, "final")], "the re-cut passed → final")


def test_guards(jobs):
    plain = jobs / "plain-cut-1009-dddd"
    plain.mkdir()
    jw(plain / "request.json", {"workflow": "cut", "format": "long", "sponsored": False})
    jw(plain / "status.json", {"state": "done"})
    jw(plain / "wordiff.json", WD_OK)
    remote = cut_job(jobs, "remote-raw-1009-eeee")
    other = cut_job(jobs, "netfail-raw-1009-ffff", state="failed", wordiff=None)   # failed before the cut
    r = chain.tick(jobs, running=lambda jid: jid == remote.name)
    check(r == [], f"no chain, factory-running, or a non-word failure: untouched {r}")
    check(not (plain / "queue.json").exists() and not (remote / "queue.json").exists()
          and not (other / "queue.json").exists(), "nothing queued")
    (jobs / "junk-1009-gggg").mkdir()
    (jobs / "junk-1009-gggg" / "request.json").write_text("{not json")
    check(chain.tick(jobs) == [(remote.name, "final")], "a broken folder is skipped; the rest advance")


def test_worker_wiring():
    loader = importlib.machinery.SourceFileLoader("aieditor_worker", str(ROOT / "bin" / "aieditor-worker"))
    spec = importlib.util.spec_from_loader("aieditor_worker", loader)
    W = importlib.util.module_from_spec(spec)
    loader.exec_module(W)
    check("chain_tick()" in inspect.getsource(W.main), "main() runs the chain tick")
    check("chain" not in inspect.getsource(W.once) and "chain" not in inspect.getsource(W.execute),
          "--once / execute never chain (a droplet cannot create jobs)")
    seen = []
    real, err = W.chain.tick, sys.stderr
    W.chain.tick = lambda root, running=None, log=None: seen.append(root) or (_ for _ in ()).throw(RuntimeError("x"))
    sys.stderr = open(os.devnull, "w")
    try:
        W.chain_tick()                                # never raises
    finally:
        sys.stderr.close()
        sys.stderr, W.chain.tick = err, real
    check(seen == [W.config.JOBS], "the tick reads the jobs root")


def main():
    with tempfile.TemporaryDirectory() as t:
        for fn in (test_pass, test_fail, test_recover, test_guards):
            jobs = Path(t) / fn.__name__ / "jobs"
            jobs.mkdir(parents=True)
            fn(jobs)
    test_worker_wiring()
    print(f"test_chain: {N} checks passed")


def test_chain():            # pytest entry point
    main()


if __name__ == "__main__":
    main()
