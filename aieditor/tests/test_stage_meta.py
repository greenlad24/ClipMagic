"""The worker's per-stage timing metadata (bin/aieditor-worker stage_meta), read by the Lab's ETA
model (lab/server/src/aieditor/eta.ts):

  box       a finished stage records machine "box", the box's vCPUs, source / output minutes
  factory   on a factory server (AIEDITOR_FACTORY_SERVER=1) the size slug + region come from the
            job's runner.json (the main box writes it before the folder is sent)
  beats     a graphics note "13/13 screencast(s) …" records 13 beats
  lifecycle meta is written only when a RUNNING stage finishes "done"; a rerun clears the old
            one; a failed stage records none; broken files never fail the stage (meta None/partial)

Run: python3 tests/test_stage_meta.py
"""
import importlib.machinery
import importlib.util
import json
import os
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
N = 0


def check(cond, msg):
    global N
    if not cond:
        raise AssertionError(msg)
    N += 1


def load_worker():
    loader = importlib.machinery.SourceFileLoader("aieditor_worker_meta", str(ROOT / "bin" / "aieditor-worker"))
    spec = importlib.util.spec_from_loader("aieditor_worker_meta", loader)
    W = importlib.util.module_from_spec(spec)
    loader.exec_module(W)
    return W


def job_dir(t, name):
    d = Path(t) / "jobs" / name
    d.mkdir(parents=True)
    (d / "request.json").write_text(json.dumps({"format": "long", "workflow": "creative"}))
    (d / "source.json").write_text(json.dumps({"duration": 906.0}))
    (d / "edl.json").write_text(json.dumps({"videos": [{"duration": 600.0}, {"duration": 280.0}]}))
    return d


def test_meta(W, t):
    d = job_dir(t, "meta-box")
    os.environ.pop("AIEDITOR_FACTORY_SERVER", None)
    m = W.stage_meta(d, "1 preview(s)")
    check(m["machine"] == "box" and m["cpus"] == os.cpu_count() and m["region"] is None, f"box machine: {m}")
    check(m["src_min"] == 15.1 and m["out_min"] == round(880 / 60, 3), f"units: {m}")
    check("beats" not in m, "no beats without a screencast note")
    check(W.stage_meta(d, "13/13 screencast(s) (13 in the logged-in app), 11 overlay(s), $9.84")["beats"] == 13, "beats")
    check(W.stage_meta(d, "0 screencast(s), 48 overlay(s)")["beats"] == 0, "zero beats is recorded")

    (d / "runner.json").write_text(json.dumps({"kind": "factory", "size": "s-8vcpu-32gb-amd", "region": "blr1"}))
    os.environ["AIEDITOR_FACTORY_SERVER"] = "1"
    try:
        m = W.stage_meta(d, None)
    finally:
        os.environ.pop("AIEDITOR_FACTORY_SERVER", None)
    check(m["machine"] == "s-8vcpu-32gb-amd" and m["region"] == "blr1", f"factory size + region: {m}")
    check(W.stage_meta(d, None)["machine"] == "box", "runner.json alone does not make the box a server")

    (d / "edl.json").write_text("{broken")
    (d / "source.json").write_text(json.dumps({"duration": "x"}))
    check(W.stage_meta(d, None) is None, "an unreadable duration → None, never an exception")
    (d / "source.json").unlink()
    m = W.stage_meta(d, None)
    check(m is not None and "src_min" not in m and "out_min" not in m, f"missing files → no units: {m}")


def test_lifecycle(W, t):
    d = job_dir(t, "meta-life")
    j = W.Job(d)
    j.stage("align", "running")
    check("meta" not in j.st["stages"]["align"], "no meta while running")
    j.stage("align", "done", "223 windows")
    check(j.st["stages"]["align"]["meta"]["src_min"] == 15.1, "done records meta")
    saved = json.loads((d / "status.json").read_text())
    check(saved["stages"]["align"]["meta"]["machine"] == "box", "meta is saved in status.json")
    j.stage("align", "running")
    check("meta" not in j.st["stages"]["align"], "a rerun clears the old meta")
    j.stage("align", "failed", "boom")
    check("meta" not in j.st["stages"]["align"], "a failed stage records none")
    j.stage("download", "done", "reused")
    check("meta" not in j.st["stages"]["download"], "a reused stage (never ran) records none")


def main():
    W = load_worker()
    with tempfile.TemporaryDirectory() as t:
        test_meta(W, t)
        test_lifecycle(W, t)
    print(f"test_stage_meta: {N} checks passed")


def test_stage_meta():            # pytest entry point
    main()


if __name__ == "__main__":
    sys.exit(main())
